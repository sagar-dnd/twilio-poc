/**
 * Identity, Register / Unregister and token status.
 * @param {{ twilio: import('../hooks/useTwilioDevice').TwilioDevice, identity: string, onIdentityChange: (v: string) => void, busy: boolean, onRegister: () => void }} props
 */
export default function DevicePanel({ twilio, identity, onIdentityChange, busy, onRegister }) {
  return (
    <section className="panel">
      <h2>1. Device</h2>
      <label>
        Identity
        <input
          value={identity}
          onChange={(e) => onIdentityChange(e.target.value)}
          disabled={twilio.deviceState === 'registered'}
          autoComplete="off"
        />
      </label>
      <div className="row">
        <button
          type="button"
          disabled={busy || twilio.deviceState === 'registered' || twilio.deviceState === 'registering'}
          onClick={onRegister}
        >
          {busy || twilio.deviceState === 'registering' ? 'Registering…' : 'Register Device'}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={twilio.deviceState === 'unregistered'}
          onClick={twilio.unregister}
        >
          Unregister / Destroy
        </button>
      </div>
      <dl className="meta">
        <div>
          <dt>State</dt>
          <dd data-state={twilio.deviceState}>{twilio.deviceState}</dd>
        </div>
        <div>
          <dt>Token TTL</dt>
          <dd>{twilio.tokenMeta ? `${twilio.tokenMeta.ttl}s` : '—'}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{twilio.tokenMeta ? new Date(twilio.tokenMeta.expiresAt).toLocaleTimeString() : '—'}</dd>
        </div>
      </dl>
    </section>
  )
}
