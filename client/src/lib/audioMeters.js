/**
 * Local audio meters for the Device management tab.
 * - Mic: own getUserMedia + AnalyserNode on the selected input (the SDK only reports
 *   input volume while it holds an input stream, and we unset it after every call).
 * - Speaker: SDK speakerDevices.test() plays through a plain <audio> element with no
 *   analyser, so there's nothing to measure. Instead we play our own tone through
 *   Oscillator → Gain → Analyser → MediaStreamDestination → <audio>.setSinkId(selected).
 */

function rms(analyser, buf) {
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i]
  return Math.min(1, Math.sqrt(sum / buf.length) * 4) // scale so normal speech/tone fills the meter
}

function poll(analyser, onLevel, intervalMs = 80) {
  const buf = new Float32Array(analyser.fftSize)
  const t = setInterval(() => onLevel(rms(analyser, buf)), intervalMs)
  return () => clearInterval(t)
}

/*
 * Shared mic stream: reused across meter restarts (tab switches, re-renders) so the
 * browser isn't asked for getUserMedia again and again. Released (tracks stopped)
 * a few seconds after the last meter stops, or immediately when the device changes.
 */
const RELEASE_MS = 10000
let shared = null // { deviceId, stream, ctx, refs, releaseTimer }

function releaseShared() {
  if (!shared) return
  clearTimeout(shared.releaseTimer)
  shared.stream.getTracks().forEach((tr) => tr.stop())
  shared.ctx.close().catch(() => {})
  shared = null
}

async function acquireMic(deviceId) {
  const key = deviceId || 'default'
  if (shared && shared.deviceId === key && shared.stream.getAudioTracks().some((t) => t.readyState === 'live')) {
    clearTimeout(shared.releaseTimer)
    shared.refs += 1
    return shared
  }
  releaseShared()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: key !== 'default' ? { deviceId: { exact: key } } : true,
  })
  shared = { deviceId: key, stream, ctx: new AudioContext(), refs: 1, releaseTimer: null }
  return shared
}

function releaseMic(entry) {
  if (!shared || shared !== entry) return
  shared.refs = Math.max(0, shared.refs - 1)
  if (shared.refs === 0) {
    clearTimeout(shared.releaseTimer)
    shared.releaseTimer = setTimeout(releaseShared, RELEASE_MS)
  }
}

/** Start an idle mic meter. Returns { label, stop() }. */
export async function startMicMeter(deviceId, onLevel, onMuted) {
  const entry = await acquireMic(deviceId)
  const { ctx, stream } = entry
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
  const src = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  src.connect(analyser)
  const stopPoll = poll(analyser, onLevel)
  const track = stream.getAudioTracks()[0]
  const label = track?.label || deviceId || 'default'
  // track.muted = the source isn't delivering audio (hardware/OS mute, device taken away).
  const onMute = () => onMuted?.(true)
  const onUnmute = () => onMuted?.(false)
  track?.addEventListener('mute', onMute)
  track?.addEventListener('unmute', onUnmute)
  onMuted?.(Boolean(track?.muted))
  let stopped = false
  return {
    label,
    stop() {
      if (stopped) return
      stopped = true
      stopPoll()
      track?.removeEventListener('mute', onMute)
      track?.removeEventListener('unmute', onUnmute)
      src.disconnect()
      onMuted?.(false)
      onLevel(0)
      releaseMic(entry)
    },
  }
}

/** Stop the shared mic stream now (e.g. before a call grabs the mic). */
export function releaseMicNow() {
  releaseShared()
}

/**
 * Play a test tone on the selected output and report its level. Resolves with
 * { peak, sink } when done. Throws if the tone can't be routed (caller falls back
 * to the SDK's speakerDevices.test()).
 */
export async function playSpeakerTest(sinkId, onLevel, durationMs = 2000) {
  const ctx = new AudioContext()
  try {
    await ctx.resume()
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 440
    const gain = ctx.createGain()
    gain.gain.value = 0.2
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    const dest = ctx.createMediaStreamDestination()
    osc.connect(gain)
    gain.connect(analyser)
    analyser.connect(dest)

    // Route to the chosen speaker: <audio>.setSinkId (Chrome/Edge/Firefox 116+).
    const el = new Audio()
    el.srcObject = dest.stream
    let sink = 'system default'
    if (sinkId && sinkId !== 'default' && typeof el.setSinkId === 'function') {
      await el.setSinkId(sinkId)
      sink = sinkId
    }
    // Simple 2-beep envelope so it's audibly a test.
    const t0 = ctx.currentTime
    gain.gain.setValueAtTime(0.2, t0)
    gain.gain.setValueAtTime(0, t0 + durationMs / 2000 - 0.1)
    gain.gain.setValueAtTime(0.2, t0 + durationMs / 2000)
    osc.start()
    await el.play()

    let peak = 0
    const stopPoll = poll(analyser, (v) => {
      peak = Math.max(peak, v)
      onLevel(v)
    })
    await new Promise((r) => setTimeout(r, durationMs))
    stopPoll()
    osc.stop()
    el.pause()
    el.srcObject = null
    onLevel(0)
    return { peak, sink }
  } finally {
    ctx.close().catch(() => {})
  }
}
