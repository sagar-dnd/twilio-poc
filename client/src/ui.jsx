/** Shared UI: Badge, Meter, the floating CallModal and the LogsDrawer. */
import { useEffect, useMemo, useState } from 'react'
import { useDraggable } from './hooks'
import { LOG_SOURCES } from './lib'

// --- Badge -------------------------------------------------------------------------------------

/**
 * Pill/tag. Extra props (title, data-state, key…) pass through to the element.
 * @param {{ tone?: 'warn' | 'error', as?: 'span' | 'p', children?: import('react').ReactNode } & Record<string, unknown>} props
 */
export function Badge({ tone, as: Tag = 'span', children, ...rest }) {
  return (
    <Tag className={tone ? `badge ${tone}` : 'badge'} {...rest}>
      {children}
    </Tag>
  )
}

// --- Meter -------------------------------------------------------------------------------------

/**
 * 0..1 level meter.
 * @param {{ value: number }} props
 */
export function Meter({ value }) {
  return <meter min="0" max="1" value={value} />
}

// --- CallModal ---------------------------------------------------------------------------------

function formatDuration(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Re-render every 250ms while `since` is set, returning elapsed whole seconds. */
function useElapsedSeconds(since) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [since])
  return since ? Math.max(0, Math.floor((now - since) / 1000)) : 0
}

/**
 * Floating, draggable current-call card, visible on every tab while a call is active.
 * @param {{
 *   call: import('./useTwilioDevice').ActiveCall,
 *   callState: string | null,
 *   reconnecting: boolean,
 *   muted: boolean,
 *   onToggleMute: () => void,
 *   onHangup: () => void,
 * }} props
 */
export function CallModal({ call, callState, reconnecting, muted, onToggleMute, onHangup }) {
  const [collapsed, setCollapsed] = useState(false)
  const { ref, style, handleProps } = useDraggable({
    initial: () => ({ x: window.innerWidth - 340, y: window.innerHeight - 240 }),
    refitKey: collapsed,
  })
  // answeredAt is stamped by the hook on call 'accept'.
  const elapsed = useElapsedSeconds(call?.answeredAt ?? null)
  const badge = reconnecting ? 'reconnecting' : callState || 'connecting'

  return (
    <div ref={ref} className="call-modal panel" style={style} role="dialog" aria-label="Current call">
      <div className="call-modal-head" {...handleProps}>
        <Badge data-state={badge}>{badge}</Badge>
        <strong className="mono">{formatDuration(elapsed)}</strong>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => setCollapsed((c) => !c)} aria-label="Collapse">
          {collapsed ? '▢' : '–'}
        </button>
      </div>
      {!collapsed && (
        <div className="call-modal-body">
          <div className="call-modal-peer mono">{call?.peer || 'unknown'}</div>
          <div className="hint">
            {call?.direction || '—'} · <span className="mono">{call?.sid || 'no SID yet'}</span>
          </div>
        </div>
      )}
      <div className="row">
        <button type="button" className="ghost" onClick={onToggleMute}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button type="button" className="danger" onClick={onHangup}>
          Hang up
        </button>
      </div>
    </div>
  )
}

// --- LogsDrawer --------------------------------------------------------------------------------

function matchesQuery(entry, q) {
  return [entry.msg, entry.detail, entry.source, entry.level].some(
    (v) => v != null && String(v).toLowerCase().includes(q)
  )
}

/**
 * Right-side event log with source filter and text search.
 * @param {{ open: boolean, onClose: () => void, logs: import('./useTwilioDevice').LogEntry[], onClear: () => void }} props
 */
export function LogsDrawer({ open, onClose, logs, onClear }) {
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
