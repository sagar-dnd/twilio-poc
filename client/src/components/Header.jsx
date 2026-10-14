/**
 * @param {{ logCount: number, onOpenLogs: () => void }} props
 */
export default function Header({ logCount, onOpenLogs }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-title">
          <h1>Twilio Voice SDK POC</h1>
          <p className="sub">SD-7331 · Device lifecycle, calls, audio, token refresh &amp; recovery</p>
        </div>
        <div className="header-actions">
          <button type="button" className="ghost logs-btn" onClick={onOpenLogs}>
            Logs <span className="count">{logCount}</span>
          </button>
          <a className="nav-link" href="/docs">
            Docs →
          </a>
        </div>
      </div>
    </header>
  )
}
