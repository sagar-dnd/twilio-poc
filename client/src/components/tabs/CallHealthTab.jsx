import { pushMessage } from '../../lib/api'
import { formatLastEnd, formatQuality } from '../../lib/callHealth'
import Badge from '../Badge'
import Meter from '../Meter'

/**
 * Live call quality, server-pushed messages and per-call settings.
 * @param {{ twilio: import('../../hooks/useTwilioDevice').TwilioDevice }} props
 */
export default function CallHealthTab({ twilio }) {
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
