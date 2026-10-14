import { useEffect, useState } from 'react'
import Badge from './Badge'
import { useDraggable } from '../hooks/useDraggable'

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
 *   call: import('../hooks/useTwilioDevice').ActiveCall,
 *   callState: string | null,
 *   reconnecting: boolean,
 *   muted: boolean,
 *   onToggleMute: () => void,
 *   onHangup: () => void,
 * }} props
 */
export default function CallModal({ call, callState, reconnecting, muted, onToggleMute, onHangup }) {
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
