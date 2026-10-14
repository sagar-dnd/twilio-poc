import { useEffect, useRef, useState } from 'react'
import { releaseMicNow, startMicMeter } from '../lib/audioMeters'
import { MIC_SILENT_AFTER_MS, SILENCE_LEVEL } from '../lib/constants'

/**
 * Idle mic meter on the selected input. The SDK only reports input volume while it holds
 * a mic stream (and we release it after each call), so we measure it ourselves.
 * @param {{ enabled: boolean, inputId: string, releaseNow: boolean, log: import('./twilio/useEventLog').LogFn }} opts
 *   releaseNow: drop the shared stream immediately (a call is starting or the Device is gone).
 */
export function useMicMeter({ enabled, inputId, releaseNow, log }) {
  const [level, setLevel] = useState(0)
  const [silent, setSilent] = useState(false)
  const [trackMuted, setTrackMuted] = useState(false)
  const lastLoudRef = useRef(0)

  useEffect(() => {
    if (!enabled) return
    let meter = null
    let cancelled = false
    lastLoudRef.current = Date.now()
    const onLevel = (v) => {
      setLevel(v)
      const now = Date.now()
      if (v > SILENCE_LEVEL) lastLoudRef.current = now
      // React bails out when the boolean doesn't change, so this is cheap at ~12 Hz.
      setSilent(now - lastLoudRef.current >= MIC_SILENT_AFTER_MS)
    }
    const onMuted = (m) => {
      setTrackMuted(m)
      if (m) log('warn', 'mic track muted (track.muted / mute event)', null, 'audio')
    }
    startMicMeter(inputId, onLevel, onMuted)
      .then((m) => {
        if (cancelled) return m.stop()
        meter = m
        log('info', 'idle mic meter started', m.label, 'audio')
      })
      .catch((e) => log('error', 'idle mic meter failed', e?.message || String(e), 'audio'))
    return () => {
      cancelled = true
      setSilent(false)
      if (!meter) return
      meter.stop()
      log('info', 'idle mic meter stopped', null, 'audio')
    }
  }, [enabled, inputId, log])

  useEffect(() => {
    if (releaseNow) releaseMicNow()
  }, [releaseNow])

  useEffect(() => () => releaseMicNow(), [])

  return { level, silent, trackMuted }
}
