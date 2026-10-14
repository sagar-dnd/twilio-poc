import { useRef, useState } from 'react'
import { DEFAULT_COOL_OFF_SEC, E164, POWER_LOOP_SIZE } from '../lib/constants'

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
