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
