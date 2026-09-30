import { useCallback, useEffect, useRef, useState } from 'react'
import { Device, Call } from '@twilio/voice-sdk'

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
  const [deviceState, setDeviceState] = useState('unregistered')
  const [callState, setCallState] = useState(null)
  const [activeCall, setActiveCall] = useState(null)
  const [incomingCall, setIncomingCall] = useState(null)
  const [audioDevices, setAudioDevices] = useState({ input: [], output: [] })
  const [selectedInput, setSelectedInput] = useState('')
  const [selectedOutput, setSelectedOutput] = useState('')
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

  const refreshAudioDevices = useCallback(async (device) => {
    try {
      await device.audio.fetchDevices()
      const inputs = Array.from(device.audio.availableInputDevices.values())
      const outputs = Array.from(device.audio.availableOutputDevices.values())
      setAudioDevices({
        input: inputs.map((d) => ({ id: d.deviceId, label: d.label || d.deviceId })),
        output: outputs.map((d) => ({ id: d.deviceId, label: d.label || d.deviceId })),
      })
    } catch (e) {
      log('warn', 'audio.fetchDevices failed', e.message)
    }
  }, [log])

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
      })
      call.on('cancel', () => {
        log('warn', 'call cancel')
        callRef.current = null
        setActiveCall(null)
        setCallState(null)
        setIncomingCall(null)
      })
      call.on('reject', () => {
        log('warn', 'call reject')
        setIncomingCall(null)
      })
      call.on('error', (err) => {
        setError(err.message || String(err))
        log('error', 'call error', err.message || err)
      })
      call.on('warning', (name) => log('warn', 'call warning', name))
      call.on('warning-cleared', (name) => log('info', 'call warning cleared', name))
    },
    [log]
  )

  const register = useCallback(async () => {
    setError(null)
    try {
      // Mic permission before Device — required for getUserMedia / audio devices
      await navigator.mediaDevices.getUserMedia({ audio: true })
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
        setError(err.message || String(err))
        log('error', 'device error', `${err.code || ''} ${err.message || err}`)
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

      device.audio.on('deviceChange', () => refreshAudioDevices(device))

      await device.register()
      await refreshAudioDevices(device)
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
      setDeviceState('unregistered')
      setActiveCall(null)
      setIncomingCall(null)
      log('info', 'device destroyed')
    } catch (e) {
      log('error', 'unregister failed', e.message)
    }
  }, [log])

  const connect = useCallback(
    async ({ to, toClient }) => {
      const device = deviceRef.current
      if (!device) throw new Error('Device not registered')
      setError(null)
      const params = {}
      if (toClient) params.ToClient = toClient
      else if (to) params.To = to
      else throw new Error('Need To (E.164) or ToClient')

      log('info', 'device.connect', JSON.stringify(params))
      const call = await device.connect({ params })
      wireCall(call, 'outbound')
      return call
    },
    [log, wireCall]
  )

  const hangup = useCallback(() => {
    callRef.current?.disconnect()
  }, [])

  const acceptIncoming = useCallback(() => {
    incomingCall?.accept()
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
      if (!device) return
      await device.audio.setInputDevice(deviceId)
      setSelectedInput(deviceId)
      log('info', 'input device', deviceId)
    },
    [log]
  )

  const setOutputDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current
      if (!device) return
      // ponytail: speakerDevices is a Set-like API; ceiling = single speaker for POC
      await device.audio.speakerDevices.set(deviceId)
      setSelectedOutput(deviceId)
      log('info', 'output device', deviceId)
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

  useEffect(() => {
    return () => {
      try {
        callRef.current?.disconnect()
        deviceRef.current?.destroy()
      } catch {
        /* cleanup best-effort */
      }
    }
  }, [])

  return {
    deviceState,
    callState,
    activeCall,
    incomingCall,
    audioDevices,
    selectedInput,
    selectedOutput,
    muted,
    logs,
    error,
    tokenMeta,
    register,
    unregister,
    connect,
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
