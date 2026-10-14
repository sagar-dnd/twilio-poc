import { useCallback, useRef, useState } from 'react'
import { Device, Call } from '@twilio/voice-sdk'
import { formatTwilioErr } from '../lib/twilioEvents'
import { fetchToken } from '../lib/api'
import { PREFLIGHT_SIGNALING_TIMEOUT_MS } from '../lib/constants'

/**
 * Voice JS SDK v2 PreflightTest (Device.runPreflight).
 * Places a ~15-25s test call to the TwiML app behind a "preflight" token and reports
 * MOS / RTT / jitter / packet loss / callQuality / ICE candidate pair / warnings.
 */
export function usePreflight(identity, log) {
  const testRef = useRef(null)
  const [status, setStatus] = useState('idle') // idle | connecting | connected | completed | failed
  const [latest, setLatest] = useState(null)
  const [report, setReport] = useState(null)
  const [warnings, setWarnings] = useState([])
  const [failure, setFailure] = useState(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  const timerRef = useRef(null)

  const stopTimer = () => {
    clearInterval(timerRef.current)
    timerRef.current = null
  }

  const run = useCallback(async () => {
    if (testRef.current) return
    setStatus('connecting')
    setLatest(null)
    setReport(null)
    setWarnings([])
    setFailure(null)
    setElapsedSec(0)
    const started = Date.now()
    timerRef.current = setInterval(() => setElapsedSec(Math.round((Date.now() - started) / 1000)), 1000)
    try {
      const { token } = await fetchToken({ identity: `${identity}-preflight`, purpose: 'preflight' })

      const test = Device.runPreflight(token, {
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
        signalingTimeoutMs: PREFLIGHT_SIGNALING_TIMEOUT_MS,
        // fakeMicInput needs an echo TwiML app (see README); keep real mic by default.
        fakeMicInput: false,
      })
      testRef.current = test
      log?.('info', 'preflight started', null, 'preflight')

      test.on('connected', () => {
        setStatus('connected')
        log?.('info', 'preflight connected', test.callSid, 'preflight')
      })
      test.on('sample', (s) => setLatest(s))
      test.on('warning', (name, w) => {
        setWarnings((prev) => [...prev, { name, description: w?.description }])
        log?.('warn', `preflight warning: ${name}`, w?.description, 'preflight')
      })
      test.on('completed', (r) => {
        stopTimer()
        testRef.current = null
        setReport(r)
        setStatus('completed')
        log?.('info', 'preflight completed', { callQuality: r.callQuality, mos: r.stats?.mos?.average }, 'preflight')
      })
      test.on('failed', (err) => {
        stopTimer()
        testRef.current = null
        const detail = formatTwilioErr(err) || err?.message || String(err)
        setFailure(detail)
        setStatus('failed')
        log?.('error', 'preflight failed', detail, 'preflight')
      })
    } catch (e) {
      stopTimer()
      testRef.current = null
      setFailure(e.message)
      setStatus('failed')
      log?.('error', 'preflight could not start', e.message, 'preflight')
    }
  }, [identity, log])

  const stop = useCallback(() => {
    // Raises 'failed' with 31008 (cancelled), per docs.
    testRef.current?.stop()
  }, [])

  return { status, latest, report, warnings, failure, elapsedSec, run, stop }
}

/** Summarise a PreflightTest report for display. */
export function summarizeReport(r) {
  if (!r) return null
  const pair = r.selectedIceCandidatePairStats
  const local = pair?.localCandidate
  return {
    callQuality: r.callQuality ?? '—',
    mos: r.stats?.mos?.average?.toFixed?.(2) ?? '—',
    rtt: r.stats?.rtt?.average != null ? `${Math.round(r.stats.rtt.average)} ms` : '—',
    jitter: r.stats?.jitter?.average != null ? r.stats.jitter.average.toFixed(2) : '—',
    packetLoss: r.totals?.packetsLostFraction != null ? `${Number(r.totals.packetsLostFraction).toFixed(2)}%` : '—',
    edge: r.selectedEdge || r.edge || '—',
    iceCandidate: local
      ? `${local.candidateType} / ${local.protocol}${local.networkType ? ` / ${local.networkType}` : ''}`
      : '—',
    turnRequired: r.isTurnRequired == null ? '—' : r.isTurnRequired ? 'yes (relay)' : 'no',
    signalingMs: r.networkTiming?.signaling?.duration ?? '—',
    durationSec: r.testTiming?.duration ? Math.round(r.testTiming.duration / 1000) : '—',
    callSid: r.callSid,
  }
}
