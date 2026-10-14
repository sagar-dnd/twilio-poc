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
