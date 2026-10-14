import { ERROR_CATALOG } from '../../lib/twilioEvents'
import { formatLastEnd } from '../../lib/callHealth'

const CALLEE_CODES = Object.entries(ERROR_CATALOG).filter(([, v]) => v.kind === 'callee')
import Badge from '../Badge'

/**
 * Live outcome of the current/last outbound call and the callee error → disposition table.
 * @param {{ twilio: import('../../hooks/useTwilioDevice').TwilioDevice }} props
 */
export default function OutboundOutcomesTab({ twilio }) {
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
