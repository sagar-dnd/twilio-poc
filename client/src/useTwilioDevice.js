/** The single shared Twilio Device hook. Internal pieces (event log, audio devices, re-register, wake recovery) live above it in this file. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Call, Device } from '@twilio/voice-sdk'
import {
  CLOSE_PROTECTION_MESSAGE,
  DEFAULT_RING_TIMEOUT_SEC,
  E164,
  EMPTY_HEALTH,
  INPUT_VOLUME_THROTTLE_MS,
  INVALID_DEMO_TOKEN,
  LOG_LIMIT,
  MAX_CALL_SIGNALING_TIMEOUT_MS,
  MISSED_CALLS_LIMIT,
  SAMPLE_LOG_INTERVAL_MS,
  TOKEN_REFRESH_MS,
  VOLUME_CHANGE_EPSILON,
  WAKE_TOKEN_MARGIN_MS,
  backoffMs,
  classifyError,
  createMicDeadDetector,
  errorCode,
  fetchToken,
  firstDeviceId,
  formatTwilioErr,
  mapTwilioDevices,
  parseUserMessage,
  suggestDisposition,
  toQuality,
} from './lib'

// --- Event log ---------------------------------------------------------------------------------

/**
 * @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel
 * @typedef {{ id: string, ts: string, level: LogLevel, source: string, msg: string, detail?: string }} LogEntry
 * @typedef {(level: LogLevel, msg: string, detail?: unknown, source?: string) => void} LogFn
 */

function stringifyDetail(detail) {
  if (detail == null) return undefined
  return typeof detail === 'string' ? detail : JSON.stringify(detail)
}

/** Bounded, newest-first event log shared by every hook and tab. */
function useEventLog() {
  const [logs, setLogs] = useState(/** @type {LogEntry[]} */ ([]))

  /** @type {LogFn} */
  const log = useCallback((level, msg, detail, source = 'app') => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString().slice(11, 23),
      level,
      source,
      msg,
      detail: stringifyDetail(detail),
    }
    setLogs((prev) => [entry, ...prev].slice(0, LOG_LIMIT))
  }, [])

  const clearLogs = useCallback(() => setLogs([]), [])

  return { logs, log, clearLogs }
}

// --- Audio devices -----------------------------------------------------------------------------

/**
 * Mic / speaker / ringtone selection on `device.audio` (AudioHelper).
 * @param {{ deviceRef: { current: import('@twilio/voice-sdk').Device | null }, log: LogFn, setError: (msg: string) => void }} deps
 */
function useAudioDevices({ deviceRef, log, setError }) {
  // The ref mirrors selectedInput so SDK callbacks read the latest value without re-binding.
  const selectedInputRef = useRef('')
  const [inputDevices, setInputDevices] = useState([])
  const [outputDevices, setOutputDevices] = useState([])
  const [selectedInput, setSelectedInputState] = useState('')
  const [selectedOutput, setSelectedOutput] = useState('')
  const [selectedRingtone, setSelectedRingtone] = useState('')
  const [micLevel, setMicLevel] = useState(0)
  const [outputSelectionSupported, setOutputSelectionSupported] = useState(true)

  const rememberInput = useCallback((id) => {
    selectedInputRef.current = id
    setSelectedInputState(id)
  }, [])

  const refreshAudioDevices = useCallback(
    (device) => {
      const audio = device?.audio
      if (!audio) return { input: [], output: [] }

      const input = mapTwilioDevices(audio.availableInputDevices)
      const output = mapTwilioDevices(audio.availableOutputDevices)
      setInputDevices(input)
      setOutputDevices(output)
      setOutputSelectionSupported(Boolean(audio.isOutputSelectionSupported))
      if (audio.inputDevice?.deviceId) rememberInput(audio.inputDevice.deviceId)
      const activeOut = firstDeviceId(audio.speakerDevices)
      if (activeOut) setSelectedOutput(activeOut)
      const activeRing = firstDeviceId(audio.ringtoneDevices)
      if (activeRing) setSelectedRingtone(activeRing)
      return { input, output }
    },
    [rememberInput]
  )

  /** Pick the first available devices right after register. */
  const applyInitialDevices = useCallback(
    async (device) => {
      const { input, output } = refreshAudioDevices(device)
      if (input[0]?.id) {
        await device.audio.setInputDevice(input[0].id)
        rememberInput(input[0].id)
      }
      if (device.audio.isOutputSelectionSupported && output[0]?.id) {
        await device.audio.speakerDevices.set(output[0].id)
        await device.audio.ringtoneDevices.set(output[0].id)
        setSelectedOutput(output[0].id)
        setSelectedRingtone(output[0].id)
      }
    },
    [refreshAudioDevices, rememberInput]
  )

  /** We unset the input after each call, so re-apply the chosen mic before media starts. */
  const applySelectedInput = useCallback(async (device) => {
    const inputId = selectedInputRef.current
    if (device && inputId) await device.audio.setInputDevice(inputId)
  }, [])

  const attachAudioListeners = useCallback(
    (device) => {
      let lastMicAt = 0
      device.audio.on('inputVolume', (v) => {
        const now = Date.now()
        if (now - lastMicAt < INPUT_VOLUME_THROTTLE_MS) return
        lastMicAt = now
        setMicLevel(v)
      })
      device.audio.on('deviceChange', async (lostActiveDevices) => {
        const { input, output } = refreshAudioDevices(device)
        log('info', 'audio devices changed', `${input.length} in / ${output.length} out`, 'audio')
        if (!lostActiveDevices?.length) return
        log('warn', 'lost active audio device', lostActiveDevices.map((d) => d.label || d.deviceId).join(', '), 'audio')
        const lostInput = lostActiveDevices.some((d) => d.deviceId === selectedInputRef.current)
        if (!lostInput) return
        try {
          await device.audio.setInputDevice('default')
          rememberInput('default')
          log('info', 'fell back to default mic', null, 'audio')
        } catch (e) {
          setError(`Mic unplugged and no fallback: ${formatTwilioErr(e)}`)
        }
      })
    },
    [log, refreshAudioDevices, rememberInput, setError]
  )

  const resetAudio = useCallback(() => {
    selectedInputRef.current = ''
    setInputDevices([])
    setOutputDevices([])
    setSelectedInputState('')
    setSelectedOutput('')
    setSelectedRingtone('')
    setMicLevel(0)
  }, [])

  const setInputDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current
      if (!device || !deviceId) return
      try {
        await device.audio.setInputDevice(deviceId)
        rememberInput(deviceId)
        log('info', 'setInputDevice', deviceId, 'audio')
      } catch (e) {
        setError(`Mic switch failed (31402?): ${formatTwilioErr(e)}`)
        log('error', 'setInputDevice failed', formatTwilioErr(e), 'audio')
      }
    },
    [deviceRef, log, rememberInput, setError]
  )

  const setOutputDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current
      if (!device || !deviceId || !device.audio.isOutputSelectionSupported) return
      try {
        await device.audio.speakerDevices.set(deviceId)
        setSelectedOutput(deviceId)
        log('info', 'speakerDevices.set', deviceId, 'audio')
      } catch (e) {
        log('error', 'speakerDevices.set failed', formatTwilioErr(e), 'audio')
      }
    },
    [deviceRef, log]
  )

  const setRingtoneDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current
      if (!device || !deviceId || !device.audio.isOutputSelectionSupported) return
      try {
        await device.audio.ringtoneDevices.set(deviceId)
        setSelectedRingtone(deviceId)
        log('info', 'ringtoneDevices.set', deviceId, 'audio')
      } catch (e) {
        log('error', 'ringtoneDevices.set failed', formatTwilioErr(e), 'audio')
      }
    },
    [deviceRef, log]
  )

  const testSpeaker = useCallback(async () => {
    const device = deviceRef.current
    if (!device) return
    try {
      await device.audio.speakerDevices.test()
      log('info', 'speakerDevices.test()', null, 'audio')
    } catch (e) {
      log('error', 'speaker test failed', formatTwilioErr(e), 'audio')
    }
  }, [deviceRef, log])

  const refreshDevices = useCallback(() => {
    const { input, output } = refreshAudioDevices(deviceRef.current)
    log('info', 'refresh audio devices', `${input.length} in / ${output.length} out`, 'audio')
  }, [deviceRef, refreshAudioDevices, log])

  return {
    state: {
      inputDevices,
      outputDevices,
      selectedInput,
      selectedOutput,
      selectedRingtone,
      micLevel,
      outputSelectionSupported,
    },
    actions: { setInputDevice, setOutputDevice, setRingtoneDevice, testSpeaker, refreshDevices },
    internal: { refreshAudioDevices, applyInitialDevices, applySelectedInput, attachAudioListeners, resetAudio },
  }
}

// --- Re-register with backoff ------------------------------------------------------------------

/**
 * Re-register with exponential backoff + jitter after network errors / unexpected unregister.
 * @param {{ deviceRef: { current: Device | null }, callRef: { current: unknown }, intentionalUnregisterRef: { current: boolean }, log: LogFn }} deps
 */
function useReRegister({ deviceRef, callRef, intentionalUnregisterRef, log }) {
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

// --- Wake / online recovery --------------------------------------------------------------------

/**
 * Laptop sleep / network switch: on wake or back online, refresh a near-expired token
 * and re-register if the Device dropped its registration.
 */
function useWakeRecovery({ deviceRef, intentionalUnregisterRef, tokenMeta, refreshToken, scheduleReRegister, log }) {
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

// --- useTwilioDevice ---------------------------------------------------------------------------

/**
 * @typedef {{ sid?: string, direction: 'inbound' | 'outbound', peer?: string, status: string, answeredAt?: number }} ActiveCall
 * @typedef {ReturnType<typeof useTwilioDevice>} TwilioDevice
 */

const missedEntry = (from) => ({ from, at: new Date().toLocaleTimeString() })

/**
 * One shared Voice SDK Device for the whole app: lifecycle, every Device + Call event,
 * recovery (token refresh, re-register, wake) and audio devices. See README "Event handling scenarios".
 * @param {string} identity
 */
export function useTwilioDevice(identity) {
  const deviceRef = useRef(/** @type {Device | null} */ (null))
  const callRef = useRef(/** @type {Call | null} */ (null))
  const callEndWaiterRef = useRef(null)
  const intentionalUnregisterRef = useRef(false)
  const ringTimerRef = useRef(null)
  const lastSampleLogRef = useRef(0)
  const callMetaRef = useRef({})
  const tokenTtlRef = useRef(null)
  const ringTimeoutSecRef = useRef(DEFAULT_RING_TIMEOUT_SEC)
  const micDetectorRef = useRef(null)

  const [deviceState, setDeviceState] = useState('unregistered')
  const [callState, setCallState] = useState(null)
  const [activeCall, setActiveCall] = useState(/** @type {ActiveCall | null} */ (null))
  const [incomingCall, setIncomingCall] = useState(/** @type {Call | null} */ (null))
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState(null)
  const [tokenMeta, setTokenMeta] = useState(null)
  const [health, setHealth] = useState(EMPTY_HEALTH)
  const [missedCalls, setMissedCalls] = useState([])
  const [lastEnd, setLastEnd] = useState(null)
  const [ringTimeoutSec, setRingTimeoutSecState] = useState(DEFAULT_RING_TIMEOUT_SEC)
  const [shortTtl, setShortTtl] = useState(null)

  const { logs, log, clearLogs } = useEventLog()
  const audio = useAudioDevices({ deviceRef, log, setError })
  const { refreshAudioDevices, applyInitialDevices, applySelectedInput, attachAudioListeners, resetAudio } =
    audio.internal
  const { scheduleReRegister, cancelReRegister, resetAttempts } = useReRegister({
    deviceRef,
    callRef,
    intentionalUnregisterRef,
    log,
  })

  const patchHealth = useCallback((patch) => setHealth((h) => ({ ...h, ...patch })), [])

  const clearRingTimer = () => {
    clearTimeout(ringTimerRef.current)
    ringTimerRef.current = null
  }

  const endCall = useCallback(
    (call, info) => {
      clearRingTimer()
      micDetectorRef.current?.reset()
      const meta = callMetaRef.current
      const end = {
        ...info,
        sid: call?.parameters?.CallSid,
        direction: meta.direction,
        wasAnswered: Boolean(meta.acceptedAt),
        hungUpBy: meta.hungUpBy || (meta.acceptedAt ? 'customer' : null),
        amd: meta.amd || null,
        dialResult: meta.dialResult || null,
        durationSec: meta.acceptedAt ? Math.round((Date.now() - meta.acceptedAt) / 1000) : 0,
      }
      end.disposition = suggestDisposition(end)
      setLastEnd(end)
      log(end.reason === 'error' ? 'error' : 'info', 'call ended', end)
      if (callRef.current === call) {
        callRef.current = null
        setActiveCall(null)
        setCallState(null)
        setMuted(false)
        setHealth(EMPTY_HEALTH)
      }
      // Release the mic between calls so the OS mic indicator turns off.
      const device = deviceRef.current
      if (device?.audio?.unsetInputDevice && !device.calls?.length) {
        device.audio.unsetInputDevice().catch(() => {})
      }
      const wait = callEndWaiterRef.current
      callEndWaiterRef.current = null
      wait?.(end)
    },
    [log]
  )

  const startRingTimer = useCallback(
    (call) => {
      const sec = ringTimeoutSecRef.current
      if (sec <= 0) return
      // Agent-side ring cap so the dialer moves on even if the carrier keeps ringing.
      ringTimerRef.current = setTimeout(() => {
        if (call.status() === Call.State.Open || call.status() === Call.State.Closed) return
        log('warn', `no answer after ${sec}s — disconnecting`, null, 'call')
        callMetaRef.current.noAnswer = true
        callMetaRef.current.hungUpBy = 'timeout'
        call.disconnect()
      }, sec * 1000)
    },
    [log]
  )

  const onUserMessage = useCallback(
    (message) => {
      const msg = parseUserMessage(message)
      const { content } = msg
      if (msg.type === 'amd') {
        callMetaRef.current.amd = content.answeredBy?.startsWith('machine') ? 'machine' : content.answeredBy
        patchHealth({ amd: content.answeredBy })
      } else if (msg.type === 'transfer') {
        patchHealth({ transfer: content.status })
      } else if (msg.type === 'carrier') {
        patchHealth({ carrier: content.status })
      } else if (msg.type === 'dial-result') {
        callMetaRef.current.dialResult = content.status
      }
      log('info', `messageReceived: ${msg.type}`, content, 'call')
    },
    [log, patchHealth]
  )

  const wireCall = useCallback(
    (call, direction, dialed) => {
      callRef.current = call
      callMetaRef.current = { direction, startedAt: Date.now() }
      const peer =
        direction === 'inbound'
          ? call.parameters?.From
          : dialed || call.customParameters?.get?.('To') || call.parameters?.To
      setActiveCall({ sid: call.parameters?.CallSid, direction, peer, status: call.status() })
      setCallState(call.status())
      setHealth(EMPTY_HEALTH)
      log('info', `call ${direction}`, call.status(), 'call')
      micDetectorRef.current = createMicDeadDetector({
        onChange: (dead) => {
          patchHealth({ micDead: dead })
          log(dead ? 'warn' : 'info', dead ? 'mic looks dead (input ~0 for 5s)' : 'mic input recovered', null, 'call')
        },
      })
      if (direction === 'outbound') startRingTimer(call)

      const syncStatus = () => {
        const s = call.status()
        setCallState(s)
        setActiveCall((prev) => (prev ? { ...prev, status: s, sid: call.parameters?.CallSid } : prev))
      }
      const dropIncoming = () => setIncomingCall((cur) => (cur === call ? null : cur))

      call.on('ringing', (hasEarlyMedia) => {
        syncStatus()
        patchHealth({ earlyMedia: Boolean(hasEarlyMedia) })
        log('info', 'ringing', { hasEarlyMedia }, 'call')
      })
      call.on('accept', () => {
        clearRingTimer()
        callMetaRef.current.acceptedAt = Date.now()
        syncStatus()
        setActiveCall((prev) => (prev ? { ...prev, answeredAt: callMetaRef.current.acceptedAt } : prev))
        log('info', 'accept (media connected)', call.parameters?.CallSid, 'call')
      })
      call.on('disconnect', () => {
        syncStatus()
        const reason = callMetaRef.current.noAnswer ? 'no-answer-timeout' : 'disconnect'
        endCall(call, { reason, status: call.status() })
      })
      call.on('cancel', () => {
        // Inbound only: caller hung up before we answered → missed call.
        log('warn', 'cancel (caller hung up before answer)', call.parameters?.From, 'call')
        dropIncoming()
        setMissedCalls((m) => [missedEntry(call.parameters?.From), ...m].slice(0, MISSED_CALLS_LIMIT))
        endCall(call, { reason: 'cancel', status: call.status() })
      })
      call.on('reject', () => {
        log('warn', 'reject', call.parameters?.From, 'call')
        dropIncoming()
        endCall(call, { reason: 'reject', status: call.status() })
      })
      call.on('error', (err) => {
        const info = classifyError(err)
        const detail = formatTwilioErr(err)
        setError(`${info.label}: ${detail}`)
        log('error', `call error [${info.kind}]`, detail, 'call')
        // Media errors (31401/31402) end the call; callee outcomes come with improved precision.
        if (call.status() === Call.State.Closed || info.kind === 'callee' || info.kind === 'mic') {
          endCall(call, { reason: 'error', status: call.status(), code: info.code, error: detail })
        }
      })
      call.on('mute', (isMuted) => {
        setMuted(isMuted)
        log('info', 'mute', isMuted, 'call')
      })
      call.on('reconnecting', (err) => {
        patchHealth({ reconnecting: true })
        log('warn', 'reconnecting (network blip)', formatTwilioErr(err), 'call')
      })
      call.on('reconnected', () => {
        patchHealth({ reconnecting: false })
        log('info', 'reconnected', null, 'call')
      })
      call.on('sample', (sample) => {
        const quality = toQuality(sample)
        patchHealth({ quality })
        // sample fires every 1s; log sparsely to keep the panel readable.
        if (Date.now() - lastSampleLogRef.current > SAMPLE_LOG_INTERVAL_MS) {
          lastSampleLogRef.current = Date.now()
          log('debug', 'sample', quality, 'call')
        }
      })
      call.on('volume', (input, output) => {
        micDetectorRef.current?.sample(input, call.isMuted())
        // Skip tiny changes: volume fires ~20x/s and would re-render the whole app.
        setHealth((h) =>
          Math.abs(h.inputLevel - input) > VOLUME_CHANGE_EPSILON ||
          Math.abs(h.outputLevel - output) > VOLUME_CHANGE_EPSILON
            ? { ...h, inputLevel: input, outputLevel: output }
            : h
        )
      })
      call.on('warning', (name, data) => {
        setHealth((h) => ({ ...h, warnings: Array.from(new Set([...h.warnings, name])) }))
        log('warn', `warning: ${name}`, data?.value ?? data?.values ?? null, 'call')
      })
      call.on('warning-cleared', (name) => {
        setHealth((h) => ({ ...h, warnings: h.warnings.filter((w) => w !== name) }))
        log('info', `warning cleared: ${name}`, null, 'call')
      })
      call.on('messageReceived', onUserMessage)
      call.on('messageSent', (message) => log('info', 'messageSent', message?.voiceEventSid, 'call'))
      call.on('audio', (remoteAudio) => log('debug', 'remote audio element ready', remoteAudio?.tagName, 'call'))
    },
    [log, endCall, patchHealth, startRingTimer, onUserMessage]
  )

  const refreshToken = useCallback(
    async (why) => {
      const device = deviceRef.current
      if (!device) return
      try {
        const next = await fetchToken({ identity, ttl: tokenTtlRef.current })
        device.updateToken(next.token)
        setTokenMeta({ identity: next.identity, ttl: next.ttl, expiresAt: next.expiresAt })
        log('info', 'token updated', why, 'device')
      } catch (e) {
        setError(e.message)
        log('error', 'token refresh failed', e.message, 'device')
      }
    },
    [identity, log]
  )

  const onIncoming = useCallback(
    (call) => {
      const from = call.parameters?.From
      const busy = Boolean(callRef.current)
      log('info', busy ? 'incoming while on a call (ringing)' : 'incoming', from, 'device')
      setIncomingCall(call)
      if (!busy) {
        wireCall(call, 'inbound')
        return
      }
      // Always ring; agent decides. Don't replace the active call until accept.
      call.on('cancel', () => {
        log('warn', 'cancel (caller hung up before answer)', from, 'call')
        setIncomingCall((cur) => (cur === call ? null : cur))
        setMissedCalls((m) => [missedEntry(from), ...m].slice(0, MISSED_CALLS_LIMIT))
      })
      call.on('reject', () => {
        log('warn', 'reject', from, 'call')
        setIncomingCall((cur) => (cur === call ? null : cur))
      })
    },
    [log, wireCall]
  )

  const attachDeviceListeners = useCallback(
    (device) => {
      device.on('registering', () => {
        setDeviceState('registering')
        log('info', 'registering', null, 'device')
      })
      device.on('registered', () => {
        resetAttempts()
        setDeviceState('registered')
        log('info', 'registered', null, 'device')
        refreshAudioDevices(device)
      })
      device.on('unregistered', () => {
        setDeviceState('unregistered')
        log('warn', 'unregistered', intentionalUnregisterRef.current ? 'by agent' : 'unexpected', 'device')
        if (!intentionalUnregisterRef.current) scheduleReRegister('unexpected unregister')
      })
      device.on('error', (err) => {
        const info = classifyError(err)
        const detail = formatTwilioErr(err)
        setError(`${info.label}: ${detail}`)
        log('error', `device error [${info.kind}]`, detail, 'device')
        if (info.kind === 'token') refreshToken(`error ${info.code}`)
        else if (info.kind === 'network') scheduleReRegister(`error ${info.code}`)
      })
      device.on('incoming', onIncoming)
      device.on('tokenWillExpire', () => {
        log('warn', 'tokenWillExpire', null, 'device')
        refreshToken('tokenWillExpire')
      })
      device.on('destroyed', () => {
        setDeviceState('destroyed')
        log('info', 'destroyed', null, 'device')
      })
      attachAudioListeners(device)
    },
    [log, resetAttempts, refreshAudioDevices, scheduleReRegister, refreshToken, onIncoming, attachAudioListeners]
  )

  /** Mic permission before creating the Device (best practice): surfaces 31401/31402 early. */
  const ensureMicPermission = useCallback(async () => {
    try {
      const preview = await navigator.mediaDevices.getUserMedia({ audio: true })
      preview.getTracks().forEach((t) => t.stop())
      log('info', 'mic permission granted')
    } catch (e) {
      const msg =
        e.name === 'NotAllowedError'
          ? 'Mic blocked (31401). Allow mic in site settings.'
          : `Mic unavailable (31402): ${e.name}`
      setError(msg)
      log('error', 'getUserMedia failed', `${e.name}: ${e.message}`)
      throw e
    }
  }, [log])

  const register = useCallback(async () => {
    setError(null)
    intentionalUnregisterRef.current = false
    try {
      await ensureMicPermission()

      tokenTtlRef.current = shortTtl
      const { token, identity: id, ttl, expiresAt } = await fetchToken({ identity, ttl: shortTtl })
      setTokenMeta({ identity: id, ttl, expiresAt })
      log('info', 'token fetched', `ttl=${ttl}s identity=${id}`)

      if (deviceRef.current) {
        deviceRef.current.destroy()
        deviceRef.current = null
      }
      const device = new Device(token, {
        logLevel: 1,
        tokenRefreshMs: TOKEN_REFRESH_MS,
        maxCallSignalingTimeoutMs: MAX_CALL_SIGNALING_TIMEOUT_MS,
        enableImprovedSignalingErrorPrecision: true,
        // Incoming calls ring even mid-call so the agent can accept, reject or ignore them.
        allowIncomingWhileBusy: true,
        closeProtection: CLOSE_PROTECTION_MESSAGE,
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      })
      deviceRef.current = device
      attachDeviceListeners(device)

      await device.register()
      await applyInitialDevices(device)
    } catch (e) {
      setError((prev) => prev || e.message)
      log('error', 'register failed', e.message)
      throw e
    }
  }, [identity, shortTtl, log, ensureMicPermission, attachDeviceListeners, applyInitialDevices])

  const unregister = useCallback(async () => {
    const device = deviceRef.current
    if (!device) return
    intentionalUnregisterRef.current = true
    cancelReRegister()
    try {
      if (callRef.current) {
        callMetaRef.current.hungUpBy = 'agent'
        callRef.current.disconnect()
      }
      await device.unregister()
      device.destroy()
      deviceRef.current = null
      resetAudio()
      setActiveCall(null)
      setIncomingCall(null)
    } catch (e) {
      log('error', 'unregister failed', e.message)
    }
  }, [log, cancelReRegister, resetAudio])

  const connect = useCallback(
    async ({ to, extraParams }) => {
      const device = deviceRef.current
      if (!device) throw new Error('Device not registered')
      const dest = String(to || '').trim()
      if (!E164.test(dest)) throw new Error('To must be E.164, e.g. +15551234567')
      setError(null)
      const params = { To: dest, ...extraParams }
      log('info', 'device.connect', params, 'call')
      await applySelectedInput(device)
      try {
        const call = await device.connect({ params })
        wireCall(call, 'outbound', dest)
        return call
      } catch (e) {
        const info = classifyError(e)
        setError(`${info.label}: ${formatTwilioErr(e)}`)
        log('error', `connect failed [${info.kind}]`, formatTwilioErr(e), 'call')
        throw e
      }
    },
    [log, wireCall, applySelectedInput]
  )

  /** Resolves with the end summary when the call finishes (used by the power loop). */
  const connectUntilEnd = useCallback(
    async ({ to }) => {
      const ended = new Promise((resolve) => {
        callEndWaiterRef.current = resolve
      })
      try {
        await connect({ to })
      } catch (e) {
        callEndWaiterRef.current = null
        const end = { reason: 'failed', error: e.message || String(e), code: errorCode(e) }
        end.disposition = suggestDisposition({ ...end, reason: 'error' })
        return end
      }
      return ended
    },
    [connect]
  )

  const hangup = useCallback(() => {
    if (!callRef.current) return
    callMetaRef.current.hungUpBy = 'agent'
    callRef.current.disconnect()
  }, [])

  const acceptIncoming = useCallback(async () => {
    if (!incomingCall) return
    await applySelectedInput(deviceRef.current)
    const current = callRef.current
    if (current && current !== incomingCall) {
      // One active call at a time: accepting while busy ends the current call.
      log('warn', 'accepting incoming — ending current call', current.parameters?.CallSid, 'call')
      callMetaRef.current.hungUpBy = 'agent'
      current.disconnect()
      incomingCall.removeAllListeners('cancel')
      incomingCall.removeAllListeners('reject')
      wireCall(incomingCall, 'inbound')
    }
    incomingCall.accept()
    setIncomingCall(null)
  }, [incomingCall, log, wireCall, applySelectedInput])

  const rejectIncoming = useCallback(() => {
    incomingCall?.reject()
    setIncomingCall(null)
  }, [incomingCall])

  const ignoreIncoming = useCallback(() => {
    // ignore() only stops local ringing; the caller rings until timeout → cancel → missed.
    incomingCall?.ignore()
    log('info', 'incoming ignored', incomingCall?.parameters?.From, 'call')
    setIncomingCall(null)
  }, [incomingCall, log])

  const toggleMute = useCallback(() => {
    const call = callRef.current
    if (call) call.mute(!call.isMuted())
  }, [])

  /** @returns {Promise<boolean>} whether the message was handed to Twilio. */
  const sendMessage = useCallback(
    async (content) => {
      const call = callRef.current
      if (!call) return false
      try {
        await call.sendMessage({
          content: JSON.stringify(content),
          contentType: 'application/json',
          messageType: 'user-defined-message',
        })
        return true
      } catch (e) {
        log('error', 'sendMessage failed', formatTwilioErr(e), 'call')
        return false
      }
    },
    [log]
  )

  const setRingTimeoutSec = useCallback((sec) => {
    const n = Math.max(0, Number(sec) || 0)
    ringTimeoutSecRef.current = n
    setRingTimeoutSecState(n)
  }, [])

  /** Demo the token-error → refresh path. */
  const simulateExpiredToken = useCallback(() => {
    const device = deviceRef.current
    if (!device) return
    device.updateToken(INVALID_DEMO_TOKEN)
    log('warn', 'injected invalid token — next action should error (20101/31204)')
  }, [log])

  const clearError = useCallback(() => setError(null), [])

  useWakeRecovery({ deviceRef, intentionalUnregisterRef, tokenMeta, refreshToken, scheduleReRegister, log })

  // Destroy only on real page leave: a StrictMode remount must not drop the Device.
  useEffect(() => {
    const teardown = () => {
      try {
        callRef.current?.disconnect()
        deviceRef.current?.destroy()
        deviceRef.current = null
      } catch {
        // Best-effort during unload.
      }
    }
    window.addEventListener('pagehide', teardown)
    return () => window.removeEventListener('pagehide', teardown)
  }, [])

  return {
    deviceState,
    callState,
    activeCall,
    incomingCall,
    ...audio.state,
    muted,
    logs,
    error,
    tokenMeta,
    health,
    missedCalls,
    lastEnd,
    ringTimeoutSec,
    shortTtl,
    setShortTtl,
    setRingTimeoutSec,
    register,
    unregister,
    connect,
    connectUntilEnd,
    hangup,
    acceptIncoming,
    rejectIncoming,
    ignoreIncoming,
    toggleMute,
    sendMessage,
    ...audio.actions,
    simulateExpiredToken,
    log,
    clearLogs,
    clearError,
  }
}
