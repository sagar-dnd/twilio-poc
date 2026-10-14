import { summarizeReport } from '../../hooks/usePreflight'
import Badge from '../Badge'

/**
 * @param {{ twilio: import('../../hooks/useTwilioDevice').TwilioDevice, preflight: ReturnType<typeof import('../../hooks/usePreflight').usePreflight> }} props
 */
export default function PreflightTab({ twilio, preflight }) {
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
