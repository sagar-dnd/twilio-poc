import { useCallback, useEffect, useRef, useState } from 'react'
import { Device, Call } from '@twilio/voice-sdk'

function formatTwilioErr(err) {
  if (!err) return ''
  const inner = err.twilioError || err.originalError || {}
  const code = err.code ?? inner.code
  const explanation = err.explanation || inner.explanation || ''
  const causes = err.causes || inner.causes
  const bits = [code, err.message || inner.message, explanation]
  if (Array.isArray(causes) && causes.length) bits.push(causes.join('; '))
  return bits.filter(Boolean).join(' — ')
}

function mapTwilioDevices(map) {
  if (!map) return []
  return Array.from(map.entries()).map(([key, d]) => ({
    id: d.deviceId || key,
    label: d.label || d.deviceId || key,
  }))
}

async function fetchToken(identity) {
  const q = new URLSearchParams({ identity })
  const res = await fetch(`/token?${q}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `token ${res.status}`)
  }
  return res.json()
}

/**
 * Twilio Voice Device lifecycle for SD-7331 POC.
 * Covers: setup/register/cleanup, token refresh, call events, audio devices, errors.
 */
export function useTwilioDevice(identity) {
  const deviceRef = useRef(null)
  const callRef = useRef(null)
  const selectedInputRef = useRef('')
  const callEndWaiterRef = useRef(null)
  const [deviceState, setDeviceState] = useState('unregistered')
  const [callState, setCallState] = useState(null)
  const [activeCall, setActiveCall] = useState(null)
  const [incomingCall, setIncomingCall] = useState(null)
  const [inputDevices, setInputDevices] = useState([])
  const [outputDevices, setOutputDevices] = useState([])
  const [selectedInput, setSelectedInput] = useState('')
  const [selectedOutput, setSelectedOutput] = useState('')
  const [outputSelectionSupported, setOutputSelectionSupported] = useState(true)
  const [muted, setMuted] = useState(false)
  const [logs, setLogs] = useState([])
  const [error, setError] = useState(null)
  const [tokenMeta, setTokenMeta] = useState(null)

  const log = useCallback((level, msg, detail) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString().slice(11, 23),
      level,
      msg,
      detail: detail != null ? String(detail) : undefined,
    }
    setLogs((prev) => [entry, ...prev].slice(0, 200))
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
      if (audio.inputDevice?.deviceId) {
        selectedInputRef.current = audio.inputDevice.deviceId
        setSelectedInput(audio.inputDevice.deviceId)
      }
      const speakers = audio.speakerDevices?.get?.()
      const activeOut = speakers && speakers.size ? Array.from(speakers)[0]?.deviceId : ''
      if (activeOut) setSelectedOutput(activeOut)
      log('info', 'audio devices (sdk)', `mic=${input.length} speaker=${output.length}`)
      return { input, output }
    },
    [log]
  )

  const finishCall = useCallback((info) => {
    const wait = callEndWaiterRef.current
    callEndWaiterRef.current = null
    wait?.(info)
  }, [])

  const wireCall = useCallback(
    (call, direction) => {
      callRef.current = call
      setActiveCall({ sid: call.parameters?.CallSid, direction, status: call.status() })
      setCallState(call.status())
      log('info', `call ${direction}`, call.status())

      const onStatus = () => {
        const s = call.status()
        setCallState(s)
        setActiveCall((prev) => (prev ? { ...prev, status: s, sid: call.parameters?.CallSid } : prev))
        log('info', 'call status', s)
      }

      call.on('accept', onStatus)
      call.on('ringing', onStatus)
      call.on('mute', (isMuted) => {
        setMuted(isMuted)
        log('info', 'mute', isMuted)
      })
      call.on('disconnect', () => {
        onStatus()
        log('info', 'call disconnect')
        callRef.current = null
        setActiveCall(null)
        setCallState(null)
        setMuted(false)
        const device = deviceRef.current
        if (device?.audio?.unsetInputDevice) {
          device.audio.unsetInputDevice().catch(() => {})
        }
        finishCall({ reason: 'disconnect', status: call.status() })
      })
      call.on('cancel', () => {
        log('warn', 'call cancel')
        callRef.current = null
        setActiveCall(null)
        setCallState(null)
        setIncomingCall(null)
        finishCall({ reason: 'cancel', status: call.status() })
      })
      call.on('reject', () => {
        log('warn', 'call reject')
        setIncomingCall(null)
      })
      call.on('error', (err) => {
        const detail = formatTwilioErr(err)
        setError(detail)
        log('error', 'call error', detail)
        finishCall({ reason: 'error', status: call.status(), error: detail })
      })
      call.on('warning', (name) => log('warn', 'call warning', name))
      call.on('warning-cleared', (name) => log('info', 'call warning cleared', name))
    },
    [log, finishCall]
  )

  const register = useCallback(async () => {
    setError(null)
    try {
      // Mic permission before Device so Twilio AudioHelper maps include labels
      const preview = await navigator.mediaDevices.getUserMedia({ audio: true })
      preview.getTracks().forEach((t) => t.stop())
      log('info', 'mic permission granted')

      const { token, identity: id, ttl, expiresAt } = await fetchToken(identity)
      setTokenMeta({ identity: id, ttl, expiresAt })
      log('info', 'token fetched', `ttl=${ttl}s identity=${id}`)

      // Destroy previous device if re-registering
      if (deviceRef.current) {
        deviceRef.current.destroy()
        deviceRef.current = null
      }

      const device = new Device(token, {
        logLevel: 1,
        // Fire tokenWillExpire early so we can refresh before ~1s audio glitch
        tokenRefreshMs: 30000,
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      })
      deviceRef.current = device

      device.on('registered', () => {
        setDeviceState('registered')
        log('info', 'device registered')
        refreshAudioDevices(device)
      })
      device.on('unregistered', () => {
        setDeviceState('unregistered')
        log('warn', 'device unregistered')
      })
      device.on('registering', () => {
        setDeviceState('registering')
        log('info', 'device registering')
      })
      device.on('error', (err) => {
        const detail = formatTwilioErr(err)
        setError(detail)
        log('error', 'device error', detail)
      })
      device.on('incoming', (call) => {
        log('info', 'incoming call', call.parameters?.From)
        setIncomingCall(call)
        wireCall(call, 'inbound')
      })
      device.on('tokenWillExpire', async () => {
        log('warn', 'tokenWillExpire — refreshing')
        try {
          const next = await fetchToken(identity)
          device.updateToken(next.token)
          setTokenMeta({ identity: next.identity, ttl: next.ttl, expiresAt: next.expiresAt })
          log('info', 'token updated')
        } catch (e) {
          setError(e.message)
          log('error', 'token refresh failed', e.message)
        }
      })

      device.audio.on('deviceChange', lostActiveDevices => {
        refreshAudioDevices(device)
        if (lostActiveDevices?.length) {
          log('warn', 'lost audio devices', lostActiveDevices.map((d) => d.label || d.deviceId).join(', '))
        }
      })

      await device.register()
      const { input, output } = refreshAudioDevices(device)
      if (input[0]?.id) {
        await device.audio.setInputDevice(input[0].id)
        selectedInputRef.current = input[0].id
        setSelectedInput(input[0].id)
        log('info', 'setInputDevice', input[0].label)
      }
      if (device.audio.isOutputSelectionSupported && output[0]?.id) {
        await device.audio.speakerDevices.set(output[0].id)
        await device.audio.ringtoneDevices.set(output[0].id)
        setSelectedOutput(output[0].id)
        log('info', 'output devices set', output[0].label)
      }
    } catch (e) {
      setError(e.message)
      log('error', 'register failed', e.message)
      throw e
    }
  }, [identity, log, refreshAudioDevices, wireCall])

  const unregister = useCallback(async () => {
    const device = deviceRef.current
    if (!device) return
    try {
      if (callRef.current) {
        callRef.current.disconnect()
        callRef.current = null
      }
      await device.unregister()
      device.destroy()
      deviceRef.current = null
      selectedInputRef.current = ''
      setDeviceState('unregistered')
      setInputDevices([])
      setOutputDevices([])
      setSelectedInput('')
      setSelectedOutput('')
      setActiveCall(null)
      setIncomingCall(null)
      log('info', 'device destroyed')
    } catch (e) {
      log('error', 'unregister failed', e.message)
    }
  }, [log])

  const connect = useCallback(
    async ({ to }) => {
      const device = deviceRef.current
      if (!device) throw new Error('Device not registered')
      const dest = String(to || '').trim()
      if (!/^\+[1-9]\d{6,14}$/.test(dest)) throw new Error('To must be E.164, e.g. +15551234567')
      setError(null)
      const params = { To: dest }

      log('info', 'device.connect', JSON.stringify(params))
      const inputId = selectedInputRef.current
      if (inputId) await device.audio.setInputDevice(inputId)
      const call = await device.connect({ params })
      wireCall(call, 'outbound')
      return call
    },
    [log, wireCall]
  )

  const connectUntilEnd = useCallback(
    async ({ to }) => {
      const ended = new Promise((resolve) => {
        callEndWaiterRef.current = resolve
      })
      try {
        await connect({ to })
      } catch (e) {
        callEndWaiterRef.current = null
        return { reason: 'failed', error: e.message || String(e) }
      }
      return ended
    },
    [connect]
  )

  const hangup = useCallback(() => {
    callRef.current?.disconnect()
  }, [])

  const acceptIncoming = useCallback(async () => {
    if (!incomingCall) return
    const device = deviceRef.current
    const inputId = selectedInputRef.current
    if (device && inputId) await device.audio.setInputDevice(inputId)
    incomingCall.accept()
    setIncomingCall(null)
    log('info', 'incoming accepted')
  }, [incomingCall, log])

  const rejectIncoming = useCallback(() => {
    incomingCall?.reject()
    setIncomingCall(null)
    log('info', 'incoming rejected')
  }, [incomingCall, log])

  const toggleMute = useCallback(() => {
    const call = callRef.current
    if (!call) return
    call.mute(!call.isMuted())
  }, [])

  const setInputDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current
      if (!device || !deviceId) return
      await device.audio.setInputDevice(deviceId)
      selectedInputRef.current = deviceId
      setSelectedInput(deviceId)
      log('info', 'setInputDevice', deviceId)
    },
    [log]
  )

  const setOutputDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current
      if (!device || !deviceId || !device.audio.isOutputSelectionSupported) return
      await device.audio.speakerDevices.set(deviceId)
      await device.audio.ringtoneDevices.set(deviceId)
      setSelectedOutput(deviceId)
      log('info', 'output + ringtone', deviceId)
    },
    [log]
  )

  /** Force an expired token to demo recovery / error path */
  const simulateExpiredToken = useCallback(() => {
    const device = deviceRef.current
    if (!device) return
    device.updateToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.invalid')
    log('warn', 'injected invalid token — next action should error')
  }, [log])

  // Destroy only on real page leave — React StrictMode remount must not drop the Device
  useEffect(() => {
    const teardown = () => {
      try {
        callRef.current?.disconnect()
        deviceRef.current?.destroy()
        deviceRef.current = null
      } catch {
        /* best-effort */
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
    inputDevices,
    outputDevices,
    selectedInput,
    selectedOutput,
    outputSelectionSupported,
    muted,
    logs,
    error,
    tokenMeta,
    register,
    unregister,
    connect,
    connectUntilEnd,
    hangup,
    acceptIncoming,
    rejectIncoming,
    toggleMute,
    setInputDevice,
    setOutputDevice,
    simulateExpiredToken,
    clearLogs: () => setLogs([]),
    clearError: () => setError(null),
  }
}
