import { useState } from 'react'
import { useTwilioDevice } from './useTwilioDevice'
import './App.css'

export default function App() {
  const [identity, setIdentity] = useState('agent-poc')
  const [to, setTo] = useState('')
  const [toClient, setToClient] = useState('')
  const [busy, setBusy] = useState(false)

  const twilio = useTwilioDevice(identity)

  async function onRegister() {
    setBusy(true)
    try {
      await twilio.register()
    } finally {
      setBusy(false)
    }
  }

  async function onCall() {
    setBusy(true)
    try {
      await twilio.connect({
        to: to.trim() || undefined,
        toClient: toClient.trim() || undefined,
      })
    } catch (e) {
      /* logged in hook */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Twilio Voice POC</h1>
        <p className="sub">SD-7331 — Device lifecycle, calls, audio, token refresh &amp; recovery</p>
      </header>

      {twilio.error && (
        <div className="banner error" role="alert">
          <span>{twilio.error}</span>
          <button type="button" onClick={twilio.clearError}>
            dismiss
          </button>
        </div>
      )}

      {twilio.incomingCall && (
        <div className="banner incoming" role="status">
          <span>Incoming from {twilio.incomingCall.parameters?.From || 'unknown'}</span>
          <button type="button" onClick={twilio.acceptIncoming}>
            Accept
          </button>
          <button type="button" className="ghost" onClick={twilio.rejectIncoming}>
            Reject
          </button>
        </div>
      )}

      <section className="panel">
        <h2>1. Device</h2>
        <label>
          Identity
          <input
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            disabled={twilio.deviceState === 'registered'}
            autoComplete="off"
          />
        </label>
        <div className="row">
          <button type="button" disabled={busy || twilio.deviceState === 'registered'} onClick={onRegister}>
            Register Device
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
            <dd>
              {twilio.tokenMeta
                ? new Date(twilio.tokenMeta.expiresAt).toLocaleTimeString()
                : '—'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>2. Place call</h2>
        <p className="hint">
          Outbound hits your TwiML App Voice URL (<code>POST /voice</code>). Use E.164 or dial another
          client identity (open a second browser with a different identity).
        </p>
        <label>
          To (E.164)
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="+15551234567"
            disabled={!!toClient}
          />
        </label>
        <label>
          ToClient (identity)
          <input
            value={toClient}
            onChange={(e) => setToClient(e.target.value)}
            placeholder="agent-b"
            disabled={!!to}
          />
        </label>
        <div className="row">
          <button
            type="button"
            disabled={busy || twilio.deviceState !== 'registered' || twilio.activeCall}
            onClick={onCall}
          >
            Connect
          </button>
          <button type="button" className="ghost" disabled={!twilio.activeCall} onClick={twilio.hangup}>
            Hang up
          </button>
          <button type="button" className="ghost" disabled={!twilio.activeCall} onClick={twilio.toggleMute}>
            {twilio.muted ? 'Unmute' : 'Mute'}
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
        <h2>3. Audio</h2>
        <label>
          Microphone
          <select
            value={selectedOrEmpty(twilio.selectedInput, twilio.audioDevices.input)}
            onChange={(e) => twilio.setInputDevice(e.target.value)}
            disabled={twilio.deviceState !== 'registered'}
          >
            <option value="">Default</option>
            {twilio.audioDevices.input.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Speaker
          <select
            value={selectedOrEmpty(twilio.selectedOutput, twilio.audioDevices.output)}
            onChange={(e) => twilio.setOutputDevice(e.target.value)}
            disabled={twilio.deviceState !== 'registered'}
          >
            <option value="">Default</option>
            {twilio.audioDevices.output.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel">
        <h2>4. Failure / recovery demos</h2>
        <p className="hint">
          Token auto-refreshes on <code>tokenWillExpire</code>. Inject an invalid token, then try Connect
          or wait for a device error. Unregister cleans up; Register recovers.
        </p>
        <div className="row">
          <button
            type="button"
            className="danger"
            disabled={twilio.deviceState !== 'registered'}
            onClick={twilio.simulateExpiredToken}
          >
            Inject invalid token
          </button>
          <button type="button" className="ghost" onClick={twilio.clearLogs}>
            Clear log
          </button>
        </div>
      </section>

      <section className="panel log-panel">
        <h2>Event log</h2>
        <ul className="log">
          {twilio.logs.length === 0 && <li className="empty">No events yet</li>}
          {twilio.logs.map((e) => (
            <li key={e.id} data-level={e.level}>
              <time>{e.ts}</time>
              <span className="lvl">{e.level}</span>
              <span>{e.msg}</span>
              {e.detail && <code>{e.detail}</code>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function selectedOrEmpty(selected, list) {
  if (selected && list.some((d) => d.id === selected)) return selected
  return ''
}
