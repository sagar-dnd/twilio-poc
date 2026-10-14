import { E164 } from '../../lib/constants'

/**
 * Manual dialer, REST inbound ring and missed inbound calls.
 * @param {{ twilio: import('../../hooks/useTwilioDevice').TwilioDevice, identity: string, busy: boolean, loopRunning: boolean, to: string, setTo: (v: string) => void, onCall: () => void, onRingInbound: () => void }} props
 */
export default function CallingTab({ twilio, identity, busy, loopRunning, to, setTo, onCall, onRingInbound }) {
  return (
    <>
      <section className="panel">
        <h2>2a. Incoming call</h2>
        <p className="hint">
          Device must be <strong>registered</strong>. Click Ring, or call your Twilio number after pointing its Voice
          URL to public <code>POST /voice/inbound?identity={identity}</code>.
        </p>
        <div className="row">
          <button type="button" disabled={busy || twilio.deviceState !== 'registered'} onClick={onRingInbound}>
            Ring this identity (REST inbound)
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>2b. Place outbound call</h2>
        <p className="hint">
          Outbound hits TwiML App <code>POST /voice</code>. Destination must be E.164 (e.g. <code>+15551234567</code>).
          Trial accounts can only call verified numbers.
        </p>
        <label>
          To (E.164)
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="+15551234567"
            inputMode="tel"
            autoComplete="tel"
          />
        </label>
        <div className="row">
          <button
            type="button"
            disabled={
              busy || loopRunning || twilio.deviceState !== 'registered' || twilio.activeCall || !E164.test(to.trim())
            }
            onClick={onCall}
          >
            Connect
          </button>
        </div>
        <dl className="meta">
          <div>
            <dt>Call</dt>
            <dd>{twilio.callState || 'idle'}</dd>
          </div>
          <div>
            <dt>SID</dt>
            <dd className="mono">{twilio.activeCall?.sid || '—'}</dd>
          </div>
          <div>
            <dt>Direction</dt>
            <dd>{twilio.activeCall?.direction || '—'}</dd>
          </div>
        </dl>
      </section>
      <section className="panel">
        <h2>Missed inbound</h2>
        {twilio.missedCalls.length === 0 && (
          <p className="hint">None yet. Ring this browser and hang up before answering, or Ignore an incoming call.</p>
        )}
        {twilio.missedCalls.length > 0 && (
          <>
            <h3>Missed inbound</h3>
            <ul>
              {twilio.missedCalls.map((m, i) => (
                <li key={`${m.from}-${m.at}-${i}`}>
                  {m.at} {m.from || 'unknown'} (caller hung up)
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  )
}
