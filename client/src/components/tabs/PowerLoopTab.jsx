import { DISPOSITIONS } from '../../lib/constants'

/**
 * @param {{ twilio: import('../../hooks/useTwilioDevice').TwilioDevice, loop: ReturnType<typeof import('../../hooks/usePowerLoop').usePowerLoop> }} props
 */
export default function PowerLoopTab({ twilio, loop }) {
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
