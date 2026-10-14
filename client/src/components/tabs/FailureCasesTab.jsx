/**
 * @param {{ twilio: import('../../hooks/useTwilioDevice').TwilioDevice }} props
 */
export default function FailureCasesTab({ twilio }) {
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
