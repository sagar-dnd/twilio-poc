import { useEffect } from 'react'
import { Device } from '@twilio/voice-sdk'
import { WAKE_TOKEN_MARGIN_MS } from '../../lib/constants'

/**
 * Laptop sleep / network switch: on wake or back online, refresh a near-expired token
 * and re-register if the Device dropped its registration.
 */
export function useWakeRecovery({
  deviceRef,
  intentionalUnregisterRef,
  tokenMeta,
  refreshToken,
  scheduleReRegister,
  log,
}) {
  useEffect(() => {
    const onWake = (why) => {
      const device = deviceRef.current
      if (!device || intentionalUnregisterRef.current) return
      const expiresAt = tokenMeta?.expiresAt ? new Date(tokenMeta.expiresAt).getTime() : 0
      if (expiresAt && expiresAt - Date.now() < WAKE_TOKEN_MARGIN_MS) refreshToken(`${why}: token near/after expiry`)
      if (device.state !== Device.State.Registered && device.state !== Device.State.Registering) {
        scheduleReRegister(why)
      }
    }
    const onVisible = () => document.visibilityState === 'visible' && onWake('tab visible')
    const onOnline = () => {
      log('info', 'browser online', null, 'network')
      onWake('online')
    }
    const onOffline = () => log('warn', 'browser offline', null, 'network')

    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [deviceRef, intentionalUnregisterRef, tokenMeta, refreshToken, scheduleReRegister, log])
}
