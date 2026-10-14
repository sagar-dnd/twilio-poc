/** Small React hooks used by App and the tabs. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Call, Device } from '@twilio/voice-sdk'
import {
  DEFAULT_COOL_OFF_SEC,
  E164,
  HANGUP_SIGNAL_TIMEOUT_MS,
  MIC_SILENT_AFTER_MS,
  POWER_LOOP_SIZE,
  PREFLIGHT_SIGNALING_TIMEOUT_MS,
  SILENCE_LEVEL,
  fetchToken,
  formatTwilioErr,
  playSpeakerTest,
  releaseMicNow,
  signalConferenceHangup,
  startMicMeter,
} from './lib'

// --- useHashTab --------------------------------------------------------------------------------

/**
 * Active tab mirrored in the URL hash so a reload or shared link opens the same tab.
 * @param {string[]} validIds
 * @param {string} fallback
 * @returns {[string, (id: string) => void]}
 */
export function useHashTab(validIds, fallback) {
  const [tab, setTab] = useState(() => {
    const fromHash = window.location.hash.slice(1)
    return validIds.includes(fromHash) ? fromHash : fallback
  })

  const selectTab = useCallback((id) => {
    // replaceState: switching tabs shouldn't flood the back-button history.
    window.history.replaceState(null, '', `#${id}`)
    setTab(id)
  }, [])

  return [tab, selectTab]
}

// --- useLeaveWarning ---------------------------------------------------------------------------

/** Ask the browser to confirm refresh/close while `armed` (the browser shows its own dialog). */
export function useLeaveWarning(armed) {
  useEffect(() => {
    if (!armed) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [armed])
}

// --- useCallHangup -----------------------------------------------------------------------------

/**
 * Hang-up for the call modal. For a conference (agent drop) call, first tell the server the
 * leave is intentional so the customer isn't played the "sorry" message.
 * @param {import('./useTwilioDevice').TwilioDevice} twilio
 * @param {string | null} conferenceRoom
 */
export function useCallHangup(twilio, conferenceRoom) {
  const { activeCall, hangup, log, sendMessage } = twilio

  return useCallback(async () => {
    if (conferenceRoom && activeCall?.direction === 'outbound') {
      // Two independent channels (our HTTP server and Twilio signaling); either one is enough.
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), HANGUP_SIGNAL_TIMEOUT_MS)
      const [httpOk, msgOk] = await Promise.all([
        signalConferenceHangup(conferenceRoom, ctl.signal),
        sendMessage({ type: 'agent-hangup', room: conferenceRoom }),
      ])
      clearTimeout(timer)
      log(
        httpOk || msgOk ? 'info' : 'warn',
        'agent-drop: intentional hang-up signalled',
        `http=${httpOk} in-call=${msgOk}`,
        'call'
      )
    }
    hangup()
  }, [conferenceRoom, activeCall, hangup, log, sendMessage])
}

// --- usePreflight ------------------------------------------------------------------------------

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

// --- usePowerLoop ------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Power-dialer loop: dial each number, wait for a disposition, cool off, repeat.
 * Lives at App level because the dialer and the leave-warning also read `running`.
 * @param {import('./useTwilioDevice').TwilioDevice} twilio
 */
export function usePowerLoop(twilio) {
  const [numbers, setNumbers] = useState(() => Array(POWER_LOOP_SIZE).fill(''))
  const [coolOffSec, setCoolOffSec] = useState(DEFAULT_COOL_OFF_SEC)
  const [running, setRunning] = useState(false)
  const [index, setIndex] = useState(-1)
  const [phase, setPhase] = useState('idle') // idle | calling | disposition | cooloff
  const [coolLeft, setCoolLeft] = useState(0)
  const [pendingEnd, setPendingEnd] = useState(null)
  const [results, setResults] = useState([])
  const stopRef = useRef(false)
  // Resolver for the disposition the agent picks in the UI.
  const dispositionWaitRef = useRef(null)

  function pickDisposition(disposition) {
    const resolve = dispositionWaitRef.current
    dispositionWaitRef.current = null
    setPendingEnd(null)
    resolve?.(disposition)
  }

  function waitForDisposition() {
    return new Promise((resolve) => {
      dispositionWaitRef.current = resolve
    })
  }

  async function coolOff(seconds) {
    setPhase('cooloff')
    for (let s = seconds; s > 0; s -= 1) {
      if (stopRef.current) break
      setCoolLeft(s)
      await sleep(1000)
    }
    setCoolLeft(0)
  }

  async function start() {
    const list = numbers.map((n) => n.trim())
    if (list.some((n) => !E164.test(n))) {
      alert('Enter 5 valid E.164 numbers')
      return
    }
    stopRef.current = false
    setResults([])
    setRunning(true)
    const coolSec = Math.ceil(Math.max(0, Number(coolOffSec) || 0))

    for (let i = 0; i < list.length; i += 1) {
      if (stopRef.current) break
      setIndex(i)
      setPhase('calling')
      const end = await twilio.connectUntilEnd({ to: list[i] })
      if (stopRef.current) break
      setPhase('disposition')
      setPendingEnd({ to: list[i], ...end })
      const disposition = await waitForDisposition()
      if (stopRef.current || disposition === 'stopped') break
      const sdk = end.reason + (end.error ? ` ${end.error}` : '')
      setResults((prev) => [...prev, { to: list[i], disposition, sdk, at: new Date().toLocaleTimeString() }])
      const isLast = i === list.length - 1
      if (!isLast && coolSec > 0 && !stopRef.current) await coolOff(coolSec)
    }

    setPhase('idle')
    setIndex(-1)
    setRunning(false)
    setPendingEnd(null)
  }

  function stop() {
    stopRef.current = true
    twilio.hangup()
    pickDisposition('stopped')
    setRunning(false)
    setPhase('idle')
    setCoolLeft(0)
  }

  return {
    numbers,
    setNumbers,
    coolOffSec,
    setCoolOffSec,
    running,
    index,
    phase,
    coolLeft,
    pendingEnd,
    results,
    start,
    stop,
    pickDisposition,
  }
}

// --- useDraggable ------------------------------------------------------------------------------

const MARGIN = 8

function clampToViewport(pos, el) {
  const w = el?.offsetWidth ?? 300
  const h = el?.offsetHeight ?? 160
  return {
    x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
    y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
  }
}

/**
 * Pointer-event dragging for a fixed-position element, kept inside the viewport.
 * @param {{ initial: () => { x: number, y: number }, refitKey?: unknown }} opts
 *   refitKey: re-clamp when it changes (e.g. the element was collapsed/expanded).
 */
export function useDraggable({ initial, refitKey }) {
  const ref = useRef(/** @type {HTMLElement | null} */ (null))
  const dragOffset = useRef(null)
  const [pos, setPos] = useState(initial)

  useEffect(() => {
    const fit = () => setPos((p) => clampToViewport(p, ref.current))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [refitKey])

  /** Spread onto the drag handle. Buttons inside the handle stay clickable. */
  const handleProps = {
    onPointerDown(e) {
      if (e.target.closest('button')) return
      dragOffset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove(e) {
      if (!dragOffset.current) return
      const next = { x: e.clientX - dragOffset.current.dx, y: e.clientY - dragOffset.current.dy }
      setPos(clampToViewport(next, ref.current))
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }

  function endDrag(e) {
    dragOffset.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return { ref, style: { left: pos.x, top: pos.y }, handleProps }
}

// --- useMicMeter -------------------------------------------------------------------------------

/**
 * Idle mic meter on the selected input. The SDK only reports input volume while it holds
 * a mic stream (and we release it after each call), so we measure it ourselves.
 * @param {{ enabled: boolean, inputId: string, releaseNow: boolean, log: import('./useTwilioDevice').LogFn }} opts
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

// --- useSpeakerTest ----------------------------------------------------------------------------

/**
 * Plays a measured test tone on the selected speaker, then asks the agent whether they heard it
 * (browsers can't read the OS output volume or mute state).
 * @param {{ outputId: string, fallbackTest: () => Promise<void>, log: import('./useTwilioDevice').LogFn }} opts
 */
export function useSpeakerTest({ outputId, fallbackTest, log }) {
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [noOutput, setNoOutput] = useState(false)
  const [heardPrompt, setHeardPrompt] = useState(false)
  const [mutedWarn, setMutedWarn] = useState(false)

  async function run() {
    setTesting(true)
    setNoOutput(false)
    setHeardPrompt(false)
    setMutedWarn(false)
    try {
      log('info', 'speaker test: playing tone', outputId || 'default', 'audio')
      const { peak, sink } = await playSpeakerTest(outputId, setLevel)
      const none = peak <= SILENCE_LEVEL
      setNoOutput(none)
      const msg = none ? 'speaker test: no output detected' : `speaker test done: peak level ${peak.toFixed(2)}`
      log(none ? 'warn' : 'info', msg, sink, 'audio')
    } catch (e) {
      log('warn', 'speaker test tone failed, falling back to speakerDevices.test()', e?.message || String(e), 'audio')
      await fallbackTest()
    } finally {
      setLevel(0)
      setTesting(false)
    }
    setHeardPrompt(true)
  }

  function answerHeard(heard) {
    setHeardPrompt(false)
    setMutedWarn(!heard)
    if (heard) log('info', 'speaker test: agent heard the tone', null, 'audio')
    else
      log(
        'warn',
        'speaker test: agent did NOT hear the tone — speaker muted or volume 0?',
        outputId || 'default',
        'audio'
      )
  }

  return { testing, level, noOutput, heardPrompt, mutedWarn, run, answerHeard }
}
