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
  31402: { kind: 'mic', label: 'Mic acquisition failed (busy/unplugged/bad deviceId)', action: 'fall back to default mic, open picker' },
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
  if (end.reason === 'disconnect') return end.wasAnswered ? (end.hungUpBy === 'agent' ? 'Connected (agent hangup)' : 'Connected (customer hangup)') : 'No answer'
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
  return { type: content?.type || 'unknown', content, contentType: message?.contentType, voiceEventSid: message?.voiceEventSid }
}
