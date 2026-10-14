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
