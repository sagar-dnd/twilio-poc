/**
 * Incoming call prompt (also shown while already on a call).
 * @param {{ call: import('@twilio/voice-sdk').Call | null, onAccept: () => void, onReject: () => void, onIgnore: () => void }} props
 */
export default function IncomingBanner({ call, onAccept, onReject, onIgnore }) {
  if (!call) return null
  return (
    <div className="banner incoming" role="status">
      <span>Incoming from {call.parameters?.From || 'unknown'}</span>
      <button type="button" onClick={onAccept}>
        Accept
      </button>
      <button type="button" className="ghost" onClick={onReject}>
        Reject
      </button>
      <button type="button" className="ghost" onClick={onIgnore}>
        Ignore
      </button>
    </div>
  )
}
