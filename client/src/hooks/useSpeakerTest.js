import { useState } from 'react'
import { playSpeakerTest } from '../lib/audioMeters'
import { SILENCE_LEVEL } from '../lib/constants'

/**
 * Plays a measured test tone on the selected speaker, then asks the agent whether they heard it
 * (browsers can't read the OS output volume or mute state).
 * @param {{ outputId: string, fallbackTest: () => Promise<void>, log: import('./twilio/useEventLog').LogFn }} opts
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
