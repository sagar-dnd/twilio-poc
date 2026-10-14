import { useCallback, useEffect, useRef } from 'react'
import { Device } from '@twilio/voice-sdk'
import { backoffMs } from '../../lib/twilioEvents'

/**
 * Re-register with exponential backoff + jitter after network errors / unexpected unregister.
 * @param {{ deviceRef: { current: Device | null }, callRef: { current: unknown }, intentionalUnregisterRef: { current: boolean }, log: import('./useEventLog').LogFn }} deps
 */
export function useReRegister({ deviceRef, callRef, intentionalUnregisterRef, log }) {
  const attemptRef = useRef(0)
  const timerRef = useRef(null)
  // Self-reference so the timer can reschedule with the latest callback.
  const scheduleRef = useRef(null)

  const scheduleReRegister = useCallback(
    (reason) => {
      if (intentionalUnregisterRef.current || timerRef.current) return
      const attempt = attemptRef.current++
      const wait = backoffMs(attempt)
      log('warn', `re-register in ${wait}ms (attempt ${attempt + 1})`, reason, 'device')
      timerRef.current = setTimeout(async () => {
        timerRef.current = null
        const device = deviceRef.current
        const settled =
          !device ||
          intentionalUnregisterRef.current ||
          device.state === Device.State.Registered ||
          device.state === Device.State.Registering
        if (settled) return
        // Never re-register mid-call: the call keeps its own media/signaling; retry after it ends.
        if (callRef.current) {
          scheduleRef.current?.('deferred: call in progress')
          return
        }
        try {
          await device.register()
        } catch (e) {
          scheduleRef.current?.(e.message)
        }
      }, wait)
    },
    [callRef, deviceRef, intentionalUnregisterRef, log]
  )

  useEffect(() => {
    scheduleRef.current = scheduleReRegister
  }, [scheduleReRegister])

  const cancelReRegister = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const resetAttempts = useCallback(() => {
    attemptRef.current = 0
  }, [])

  return { scheduleReRegister, cancelReRegister, resetAttempts }
}
