/** Plain (non-React) helpers: constants, Twilio event catalog, audio meters, call-health formatting and the server API. */

// --- Constants ---------------------------------------------------------------------------------

/** App-wide constants. Values that tune SDK/UX behaviour are named here instead of inlined. */

export const DEFAULT_IDENTITY = 'agent-poc'

/** @type {{ id: string, label: string }[]} */
export const TABS = [
  { id: 'calling', label: 'Calling' },
  { id: 'outcomes', label: 'Outbound outcomes' },
  { id: 'power', label: 'Power loop' },
  { id: 'preflight', label: 'Preflight' },
  { id: 'health', label: 'Call health' },
  { id: 'devices', label: 'Device management' },
  { id: 'conference', label: 'Conference call' },
  { id: 'failures', label: 'Failure cases' },
]
export const DEFAULT_TAB = 'calling'

export const E164 = /^\+[1-9]\d{6,14}$/

export const DISPOSITIONS = ['answered', 'no_answer', 'busy', 'voicemail', 'declined', 'unavailable', 'failed']
export const LOG_SOURCES = ['all', 'preflight', 'device', 'call', 'audio', 'network', 'app']

// Event log / lists
export const LOG_LIMIT = 500
export const MISSED_CALLS_LIMIT = 20

// Device options
export const TOKEN_REFRESH_MS = 30000
export const MAX_CALL_SIGNALING_TIMEOUT_MS = 30000
export const CLOSE_PROTECTION_MESSAGE = 'A call is in progress. Leave anyway?'

// Call behaviour
export const DEFAULT_RING_TIMEOUT_SEC = 30
export const SAMPLE_LOG_INTERVAL_MS = 10000
export const VOLUME_CHANGE_EPSILON = 0.02
export const INPUT_VOLUME_THROTTLE_MS = 100
export const WAKE_TOKEN_MARGIN_MS = 60000
export const INVALID_DEMO_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.invalid'

// Audio meters
export const SILENCE_LEVEL = 0.01
export const MIC_SILENT_AFTER_MS = 3000

// Power loop
export const POWER_LOOP_SIZE = 5
export const DEFAULT_COOL_OFF_SEC = 5

// Preflight
export const PREFLIGHT_SIGNALING_TIMEOUT_MS = 10000

// Conference (agent drop) demo
export const HANGUP_SIGNAL_TIMEOUT_MS = 1500
export const CONFERENCE_POLL_MS = 1000

// --- Twilio events (error catalog, dispositions, backoff, messages) ----------------------------

/**
 * Twilio Voice JS SDK v2 — error code catalog, disposition mapping, and helpers.
 * Codes verified against Twilio docs (twilio.com/docs/api/errors/<code>) and the
 * v2.0.0 changelog (31201->31402, 31208->31401, 31003->53405, 31901->53000).
 */

export const ERROR_CATALOG = {
  // Auth / token
  20101: { kind: 'token', label: 'Invalid access token', action: 'refetch token + updateToken' },
  20104: { kind: 'token', label: 'Access token expired', action: 'refetch token + updateToken' },
  31204: { kind: 'token', label: 'Invalid JWT', action: 'refetch token + updateToken' },
  31205: { kind: 'token', label: 'JWT token expired', action: 'refetch token + updateToken' },
  // Media / microphone
  31401: { kind: 'mic', label: 'Mic permission denied', action: 'show mic-permission help' },
  31402: {
    kind: 'mic',
    label: 'Mic acquisition failed (busy/unplugged/bad deviceId)',
    action: 'fall back to default mic, open picker',
  },
  // Signaling / network
  31005: { kind: 'network', label: 'Connection error (WebSocket closed)', action: 're-register with backoff' },
  31009: { kind: 'network', label: 'Transport error (WebSocket unavailable)', action: 're-register with backoff' },
  53000: { kind: 'network', label: 'Signaling connection error', action: 're-register with backoff' },
  53001: { kind: 'network', label: 'Signaling disconnected', action: 're-register with backoff' },
  53405: { kind: 'network', label: 'Media connection failed (ICE)', action: 'end call, suggest TURN/network check' },
  31003: { kind: 'network', label: 'ICE connection failed (v1 code)', action: 'end call' },
  // Callee outcomes — improved signaling precision (enableImprovedSignalingErrorPrecision)
  31480: { kind: 'callee', label: 'Temporarily unavailable', disposition: 'Unavailable' },
  31486: { kind: 'callee', label: 'Busy here', disposition: 'Busy' },
  31603: { kind: 'callee', label: 'Declined', disposition: 'Declined' },
  31404: { kind: 'callee', label: 'Not found', disposition: 'Invalid number' },
  31408: { kind: 'callee', label: 'Request timeout', disposition: 'No answer' },
  31000: { kind: 'generic', label: 'Generic error' },
  31008: { kind: 'call', label: 'Call cancelled / user aborted' },
}

export function errorCode(err) {
  return err?.code ?? err?.twilioError?.code ?? err?.originalError?.code ?? null
}

export function classifyError(err) {
  const code = errorCode(err)
  return { code, ...(ERROR_CATALOG[code] || { kind: 'unknown', label: err?.message || 'Unknown error' }) }
}

export function formatTwilioErr(err) {
  if (!err) return ''
  const inner = err.twilioError || err.originalError || {}
  const code = errorCode(err)
  const explanation = err.explanation || inner.explanation || ''
  const causes = err.causes || inner.causes
  const bits = [code, err.message || inner.message, explanation]
  if (Array.isArray(causes) && causes.length) bits.push(causes.join('; '))
  return bits.filter(Boolean).join(' — ')
}

/** Map an ended call to a suggested power-dialer disposition. */
export function suggestDisposition(end) {
  if (!end) return null
  if (end.code && ERROR_CATALOG[end.code]?.disposition) return ERROR_CATALOG[end.code].disposition
  if (end.amd === 'machine') return 'Voicemail'
  const DIAL = { busy: 'Busy', 'no-answer': 'No answer', failed: 'Failed', canceled: 'No answer' }
  if (end.dialResult && DIAL[end.dialResult]) return DIAL[end.dialResult]
  if (end.reason === 'no-answer-timeout') return 'No answer'
  if (end.reason === 'cancel') return 'Missed'
  if (end.reason === 'reject') return 'Rejected'
  if (end.reason === 'disconnect')
    return end.wasAnswered
      ? end.hungUpBy === 'agent'
        ? 'Connected (agent hangup)'
        : 'Connected (customer hangup)'
      : 'No answer'
  if (end.reason === 'error') return 'Failed'
  return null
}

/** Exponential backoff with jitter for re-register after network errors. */
export function backoffMs(attempt, base = 1000, max = 30000) {
  const exp = Math.min(max, base * 2 ** attempt)
  return Math.round(exp / 2 + Math.random() * (exp / 2))
}

/**
 * Detects a dead mic: if input volume stays ~0 for `windowMs` while the call is open
 * and not muted. Fed from call.on('volume', (input, output) => ...), ~50ms cadence.
 */
export function createMicDeadDetector({ threshold = 0.001, windowMs = 5000, onChange }) {
  let silentSince = null
  let dead = false
  return {
    sample(inputVolume, muted) {
      const now = Date.now()
      if (muted || inputVolume > threshold) {
        silentSince = null
        if (dead) {
          dead = false
          onChange?.(false)
        }
        return
      }
      if (silentSince == null) silentSince = now
      if (!dead && now - silentSince >= windowMs) {
        dead = true
        onChange?.(true)
      }
    },
    reset() {
      silentSince = null
      dead = false
    },
  }
}

/**
 * Parse a user-defined message (call.on('messageReceived')). Server sends
 * { type: 'amd' | 'transfer' | 'carrier', ... } via Call UserDefinedMessages API.
 */
export function parseUserMessage(message) {
  const raw = message?.content
  let content = raw
  if (typeof raw === 'string') {
    try {
      content = JSON.parse(raw)
    } catch {
      content = { type: 'text', text: raw }
    }
  }
  return {
    type: content?.type || 'unknown',
    content,
    contentType: message?.contentType,
    voiceEventSid: message?.voiceEventSid,
  }
}

// --- Audio meters ------------------------------------------------------------------------------

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

// --- Call health formatting --------------------------------------------------------------------

/** Pure helpers for the live call-health model shown in the UI. */

export const EMPTY_HEALTH = {
  reconnecting: false,
  warnings: [],
  quality: null,
  inputLevel: 0,
  outputLevel: 0,
  micDead: false,
  earlyMedia: false,
  amd: null,
  transfer: null,
}

/** Normalise a Call 'sample' event for display. */
export function toQuality(sample) {
  return {
    mos: sample.mos != null ? Number(sample.mos).toFixed(2) : null,
    rtt: sample.rtt,
    jitter: sample.jitter,
    packetsLostFraction: sample.packetsLostFraction != null ? Number(sample.packetsLostFraction).toFixed(2) : null,
  }
}

export function formatQuality(quality) {
  if (!quality) return '—'
  return `${quality.mos ?? '—'} / ${quality.rtt ?? '—'}ms / ${quality.jitter ?? '—'} / ${quality.packetsLostFraction ?? '—'}%`
}

export function formatLastEnd(end) {
  if (!end) return '—'
  return `${end.reason}${end.code ? ` ${end.code}` : ''} → ${end.disposition || '—'}`
}

/** Keep the first selected device id in a Twilio OutputDeviceCollection, or ''. */
export function firstDeviceId(collection) {
  const set = collection?.get?.()
  return set && set.size ? Array.from(set)[0]?.deviceId : ''
}

/** Map Twilio's availableInput/OutputDevices Map to `{ id, label }` options. */
export function mapTwilioDevices(map) {
  if (!map) return []
  return Array.from(map.entries()).map(([key, d]) => ({
    id: d.deviceId || key,
    label: d.label || d.deviceId || key,
  }))
}

/** A <select> value that exists in `list`, else '' (placeholder option). */
export function selectedOrEmpty(selected, list) {
  if (selected && list.some((d) => d.id === selected)) return selected
  return ''
}

// --- Server API --------------------------------------------------------------------------------

/** All HTTP calls to the Express server live here so endpoints are easy to find. */

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function postJson(path, body, signal) {
  return fetch(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal })
}

async function errorFrom(res, fallback) {
  const body = await res.json().catch(() => ({}))
  return new Error(body.error || fallback)
}

/**
 * @param {{ identity: string, ttl?: number | null, purpose?: 'preflight' }} opts
 * @returns {Promise<{ identity: string, token: string, ttl: number, expiresAt: number }>}
 */
export async function fetchToken({ identity, ttl, purpose }) {
  const q = new URLSearchParams({ identity })
  if (purpose) q.set('purpose', purpose)
  if (ttl) q.set('ttl', String(ttl))
  const res = await fetch(`/token?${q}`)
  if (!res.ok) throw await errorFrom(res, `token ${res.status}`)
  return res.json()
}

/** Ask the server to place a REST call to `client:<identity>`. */
export async function ringClient(identity) {
  const res = await postJson('/demo/ring-client', { identity })
  if (!res.ok) throw await errorFrom(res, `ring ${res.status}`)
}

/** Push a user-defined message to the browser leg of `callSid`. */
export async function pushMessage(callSid, content) {
  const res = await postJson('/demo/push-message', { callSid, content })
  if (!res.ok) throw new Error(`push-message ${res.status}`)
}

export async function getConferenceConfig() {
  const res = await fetch('/agent-drop/config')
  return res.json()
}

/** @returns {Promise<object | null>} null when the room is unknown. */
export async function getConferenceStatus(room) {
  const res = await fetch(`/agent-drop/status?room=${room}`)
  return res.ok ? res.json() : null
}

/** Mark the agent's next leave as intentional. Resolves false instead of throwing. */
export function signalConferenceHangup(room, signal) {
  return postJson('/agent-drop/hangup', { room }, signal)
    .then((r) => r.ok)
    .catch(() => false)
}
