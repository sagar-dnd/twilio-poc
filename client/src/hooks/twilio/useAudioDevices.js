import { useCallback, useRef, useState } from 'react'
import { formatTwilioErr } from '../../lib/twilioEvents'
import { firstDeviceId, mapTwilioDevices } from '../../lib/callHealth'
import { INPUT_VOLUME_THROTTLE_MS } from '../../lib/constants'

/**
 * Mic / speaker / ringtone selection on `device.audio` (AudioHelper).
 * @param {{ deviceRef: { current: import('@twilio/voice-sdk').Device | null }, log: import('./useEventLog').LogFn, setError: (msg: string) => void }} deps
 */
export function useAudioDevices({ deviceRef, log, setError }) {
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
