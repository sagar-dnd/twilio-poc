/** Call-focused tabs: Calling, Outbound outcomes, Power loop, Preflight, Call health, Failure cases. */
import { summarizeReport } from './hooks'
import { DISPOSITIONS, E164, ERROR_CATALOG, formatLastEnd, formatQuality, pushMessage } from './lib'
import { Badge, Meter } from './ui'

// --- Calling -----------------------------------------------------------------------------------

/**
 * Manual dialer, REST inbound ring and missed inbound calls.
 * @param {{ twilio: import('./useTwilioDevice').TwilioDevice, identity: string, busy: boolean, loopRunning: boolean, to: string, setTo: (v: string) => void, onCall: () => void, onRingInbound: () => void }} props
 */
export function CallingTab({ twilio, identity, busy, loopRunning, to, setTo, onCall, onRingInbound }) {
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

// --- Outbound outcomes -------------------------------------------------------------------------

const CALLEE_CODES = Object.entries(ERROR_CATALOG).filter(([, v]) => v.kind === 'callee')

/**
 * Live outcome of the current/last outbound call and the callee error → disposition table.
 * @param {{ twilio: import('./useTwilioDevice').TwilioDevice }} props
 */
export function OutboundOutcomesTab({ twilio }) {
  return (
    <>
      <section className="panel">
        <h2>Outbound outcomes</h2>
        <p className="hint">
          Place a call from the <strong>Calling</strong> tab (or the Power loop); outcome fields update live here.
          Callee outcomes come from <code>enableImprovedSignalingErrorPrecision</code>; carrier / dial-result / AMD need{' '}
          <code>PUBLIC_BASE_URL</code>.
        </p>
        <div className="row">
          {twilio.health.earlyMedia && twilio.callState === 'ringing' && <Badge>Early media (carrier audio)</Badge>}
        </div>
        <dl className="meta">
          <div>
            <dt>Call</dt>
            <dd>{twilio.callState || 'idle'}</dd>
          </div>
          <div>
            <dt>Carrier leg</dt>
            <dd>{twilio.health.carrier || '—'}</dd>
          </div>
          <div>
            <dt>AMD</dt>
            <dd>{twilio.health.amd || '—'}</dd>
          </div>
          <div>
            <dt>Last end → suggested disposition</dt>
            <dd className="mono">{formatLastEnd(twilio.lastEnd)}</dd>
          </div>
        </dl>
        <label>
          No-answer timeout (seconds, 0 = off)
          <input
            type="number"
            min="0"
            max="120"
            value={twilio.ringTimeoutSec}
            onChange={(e) => twilio.setRingTimeoutSec(e.target.value)}
          />
        </label>
        <h3>Callee error codes → disposition</h3>
        <table className="results">
          <thead>
            <tr>
              <th>Code</th>
              <th>Meaning</th>
              <th>Disposition</th>
            </tr>
          </thead>
          <tbody>
            {CALLEE_CODES.map(([code, v]) => (
              <tr key={code}>
                <td className="mono">{code}</td>
                <td>{v.label}</td>
                <td>{v.disposition}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}

// --- Power loop --------------------------------------------------------------------------------

/**
 * @param {{ twilio: import('./useTwilioDevice').TwilioDevice, loop: ReturnType<typeof import('./hooks').usePowerLoop> }} props
 */
export function PowerLoopTab({ twilio, loop }) {
  const {
    numbers,
    setNumbers,
    coolOffSec,
    setCoolOffSec,
    running: loopRunning,
    index: loopIndex,
    phase: loopPhase,
    coolLeft,
    pendingEnd,
    results,
    start: runPowerLoop,
    stop: stopPowerLoop,
    pickDisposition,
  } = loop
  return (
    <>
      <section className="panel">
        <h2>2c. Power loop — 5 numbers</h2>
        <p className="hint">
          Calls one E.164 number at a time. After hangup, pick a disposition, then cool-off before the next dial. Stop
          cancels the queue.
        </p>
        {numbers.map((n, i) => (
          <label key={i}>
            {i + 1}
            <input
              value={n}
              onChange={(e) => setNumbers((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              placeholder="+15551234567"
              inputMode="tel"
              disabled={loopRunning}
            />
          </label>
        ))}
        <label>
          Cool-off (seconds)
          <input
            type="number"
            min="0"
            max="120"
            value={coolOffSec}
            onChange={(e) => setCoolOffSec(e.target.value)}
            disabled={loopRunning}
          />
        </label>
        <div className="row">
          <button type="button" disabled={loopRunning || twilio.deviceState !== 'registered'} onClick={runPowerLoop}>
            Start 5-number loop
          </button>
          <button type="button" className="ghost" disabled={!loopRunning} onClick={stopPowerLoop}>
            Stop loop
          </button>
          {loopRunning && (
            <span className="hint">
              {loopPhase === 'calling' && `Calling ${loopIndex + 1}/5`}
              {loopPhase === 'disposition' && `Set disposition for ${loopIndex + 1}/5`}
              {loopPhase === 'cooloff' && `Cool-off ${coolLeft}s before ${loopIndex + 2}/5`}
            </span>
          )}
        </div>
        {pendingEnd && (
          <div className="banner incoming" role="status">
            <span>
              {pendingEnd.to} ended ({pendingEnd.reason}
              {pendingEnd.error ? `: ${pendingEnd.error}` : ''}).
              {pendingEnd.disposition && <strong> Suggested: {pendingEnd.disposition}.</strong>} Disposition:
            </span>
            {DISPOSITIONS.map((d) => (
              <button key={d} type="button" onClick={() => pickDisposition(d)}>
                {d}
              </button>
            ))}
          </div>
        )}
        {results.length > 0 && (
          <table className="results">
            <thead>
              <tr>
                <th>#</th>
                <th>Number</th>
                <th>Disposition</th>
                <th>SDK</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={`${r.to}-${r.at}-${i}`}>
                  <td>{i + 1}</td>
                  <td className="mono">{r.to}</td>
                  <td>{r.disposition}</td>
                  <td>{r.sdk}</td>
                  <td>{r.at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

// --- Preflight ---------------------------------------------------------------------------------

/**
 * @param {{ twilio: import('./useTwilioDevice').TwilioDevice, preflight: ReturnType<typeof import('./hooks').usePreflight> }} props
 */
export function PreflightTab({ twilio, preflight }) {
  const pf = summarizeReport(preflight.report)
  return (
    <>
      <section className="panel">
        <h2>0. Network test (Preflight)</h2>
        <p className="hint">
          Run before going Available (pre-shift) or after network issues. Places a ~20s test call via{' '}
          <code>Device.runPreflight</code>.
        </p>
        <div className="row">
          <button
            type="button"
            disabled={['connecting', 'connected'].includes(preflight.status) || !!twilio.activeCall}
            onClick={preflight.run}
          >
            Run network test
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!['connecting', 'connected'].includes(preflight.status)}
            onClick={preflight.stop}
          >
            Stop
          </button>
          <Badge data-state={preflight.status}>
            {preflight.status}
            {['connecting', 'connected'].includes(preflight.status) && ` · ${preflight.elapsedSec}s`}
          </Badge>
        </div>
        {preflight.latest && preflight.status === 'connected' && (
          <p className="hint mono">
            live: MOS {preflight.latest.mos?.toFixed?.(2) ?? '—'} · RTT {preflight.latest.rtt ?? '—'}ms · jitter{' '}
            {preflight.latest.jitter ?? '—'} · loss {preflight.latest.packetsLostFraction ?? '—'}%
          </p>
        )}
        {pf && (
          <dl className="meta">
            <div>
              <dt>Call quality</dt>
              <dd>
                <strong>{pf.callQuality}</strong>
              </dd>
            </div>
            <div>
              <dt>MOS (avg)</dt>
              <dd>{pf.mos}</dd>
            </div>
            <div>
              <dt>RTT (avg)</dt>
              <dd>{pf.rtt}</dd>
            </div>
            <div>
              <dt>Jitter (avg)</dt>
              <dd>{pf.jitter}</dd>
            </div>
            <div>
              <dt>Packet loss</dt>
              <dd>{pf.packetLoss}</dd>
            </div>
            <div>
              <dt>ICE candidate</dt>
              <dd>{pf.iceCandidate}</dd>
            </div>
            <div>
              <dt>TURN required</dt>
              <dd>{pf.turnRequired}</dd>
            </div>
            <div>
              <dt>Edge</dt>
              <dd>{pf.edge}</dd>
            </div>
            <div>
              <dt>Signaling</dt>
              <dd>{pf.signalingMs} ms</dd>
            </div>
            <div>
              <dt>Test duration</dt>
              <dd>{pf.durationSec}s</dd>
            </div>
          </dl>
        )}
        {preflight.warnings.length > 0 && (
          <div className="row">
            {preflight.warnings.map((w, i) => (
              <Badge tone="warn" key={`${w.name}-${i}`} title={w.description}>
                {w.name}
              </Badge>
            ))}
          </div>
        )}
        {preflight.failure && (
          <Badge as="p" tone="error">
            Failed: {preflight.failure}
          </Badge>
        )}
      </section>
    </>
  )
}

// --- Call health -------------------------------------------------------------------------------

/**
 * Live call quality, server-pushed messages and per-call settings.
 * @param {{ twilio: import('./useTwilioDevice').TwilioDevice }} props
 */
export function CallHealthTab({ twilio }) {
  async function onPushTransfer(status) {
    const callSid = twilio.activeCall?.sid
    if (!callSid) return
    try {
      await pushMessage(callSid, { type: 'transfer', status })
    } catch (e) {
      twilio.log('error', 'push transfer failed', e?.message || String(e), 'app')
    }
  }

  return (
    <>
      <section className="panel">
        <h2>2b. Call health &amp; scenarios</h2>
        <div className="row">
          {twilio.health.reconnecting && <Badge tone="warn">Reconnecting…</Badge>}
          {twilio.health.micDead && <Badge tone="error">Mic silent 5s — check mic</Badge>}
          {twilio.health.earlyMedia && twilio.callState === 'ringing' && <Badge>Early media (carrier audio)</Badge>}
          {twilio.health.warnings.map((w) => (
            <Badge tone="warn" key={w}>
              {w}
            </Badge>
          ))}
        </div>
        <dl className="meta">
          <div>
            <dt>Mic level</dt>
            <dd>
              <Meter value={twilio.health.inputLevel} />
            </dd>
          </div>
          <div>
            <dt>MOS / RTT / jitter / loss</dt>
            <dd className="mono">{formatQuality(twilio.health.quality)}</dd>
          </div>
          <div>
            <dt>AMD</dt>
            <dd>{twilio.health.amd || '—'}</dd>
          </div>
          <div>
            <dt>Carrier leg</dt>
            <dd>{twilio.health.carrier || '—'}</dd>
          </div>
          <div>
            <dt>Transfer</dt>
            <dd>{twilio.health.transfer || '—'}</dd>
          </div>
          <div>
            <dt>Last end</dt>
            <dd className="mono">{formatLastEnd(twilio.lastEnd)}</dd>
          </div>
        </dl>
        <label>
          No-answer timeout (seconds, 0 = off)
          <input
            type="number"
            min="0"
            max="120"
            value={twilio.ringTimeoutSec}
            onChange={(e) => twilio.setRingTimeoutSec(e.target.value)}
          />
        </label>
        <label>
          Token TTL override for next Register (seconds, min 60; empty = server default)
          <input
            type="number"
            min="60"
            value={twilio.shortTtl ?? ''}
            onChange={(e) => twilio.setShortTtl(e.target.value ? Number(e.target.value) : null)}
            disabled={twilio.deviceState === 'registered'}
          />
        </label>
        <div className="row">
          <button
            type="button"
            className="ghost"
            disabled={!twilio.activeCall}
            onClick={() => onPushTransfer('ringing')}
          >
            Push transfer: ringing
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!twilio.activeCall}
            onClick={() => onPushTransfer('completed')}
          >
            Push transfer: completed
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!twilio.activeCall}
            onClick={() => twilio.sendMessage({ type: 'agent-note', text: 'hello from agent' })}
          >
            Send message (messageSent)
          </button>
        </div>
      </section>
    </>
  )
}

// --- Failure cases -----------------------------------------------------------------------------

/**
 * @param {{ twilio: import('./useTwilioDevice').TwilioDevice }} props
 */
export function FailureCasesTab({ twilio }) {
  return (
    <>
      <section className="panel">
        <h2>4. Failure / recovery demos</h2>
        <p className="hint">
          Token auto-refreshes on <code>tokenWillExpire</code>. Inject an invalid token, then try Connect or wait for a
          device error. Unregister cleans up; Register recovers.
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
    </>
  )
}
