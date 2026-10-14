import { useMemo, useState } from 'react'
import { LOG_SOURCES } from '../lib/constants'

function matchesQuery(entry, q) {
  return [entry.msg, entry.detail, entry.source, entry.level].some(
    (v) => v != null && String(v).toLowerCase().includes(q)
  )
}

/**
 * Right-side event log with source filter and text search.
 * @param {{ open: boolean, onClose: () => void, logs: import('../hooks/twilio/useEventLog').LogEntry[], onClear: () => void }} props
 */
export default function LogsDrawer({ open, onClose, logs, onClear }) {
  const [logFilter, setLogFilter] = useState('all')
  const [logQuery, setLogQuery] = useState('')
  const visibleLogs = useMemo(() => {
    const q = logQuery.trim().toLowerCase()
    return logs.filter((e) => (logFilter === 'all' || e.source === logFilter) && (!q || matchesQuery(e, q)))
  }, [logs, logFilter, logQuery])

  return (
    <>
      {open && <div className="sheet-backdrop" onClick={onClose} />}
      <aside className={open ? 'sheet open' : 'sheet'} aria-hidden={!open}>
        <div className="sheet-head">
          <h2>Event log</h2>
          <button type="button" className="ghost" onClick={onClear}>
            Clear
          </button>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <input
          className="sheet-search"
          value={logQuery}
          onChange={(e) => setLogQuery(e.target.value)}
          placeholder="Search message / event / code…"
        />
        <div className="row">
          {LOG_SOURCES.map((src) => (
            <button
              key={src}
              type="button"
              className={logFilter === src ? '' : 'ghost'}
              onClick={() => setLogFilter(src)}
            >
              {src}
            </button>
          ))}
        </div>
        <p className="hint">
          {visibleLogs.length} / {logs.length} events
        </p>
        <ul className="log">
          {visibleLogs.length === 0 && <li className="empty">No events</li>}
          {visibleLogs.map((e) => (
            <li key={e.id} data-level={e.level}>
              <time>{e.ts}</time>
              <span className="lvl">{e.level}</span>
              <span className="lvl">{e.source}</span>
              <span>{e.msg}</span>
              {e.detail && <code>{e.detail}</code>}
            </li>
          ))}
        </ul>
      </aside>
    </>
  )
}
