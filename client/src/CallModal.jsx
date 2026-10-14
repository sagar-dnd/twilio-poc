import { useEffect, useRef, useState } from 'react'

const MARGIN = 8

function clamp(pos, el) {
  const w = el?.offsetWidth ?? 300
  const h = el?.offsetHeight ?? 160
  return {
    x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
    y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
  }
}

function fmt(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Floating, draggable current-call card (pointer events, kept inside the viewport). */
export default function CallModal({ call, callState, reconnecting, muted, onToggleMute, onHangup }) {
  const ref = useRef(null)
  const drag = useRef(null)
  const [pos, setPos] = useState(() => ({ x: window.innerWidth - 340, y: window.innerHeight - 240 }))
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // answeredAt is stamped by the hook on call 'accept'.
  const openedAt = call?.answeredAt ?? null
  useEffect(() => {
    if (!openedAt) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [openedAt])

  // Re-clamp on mount, collapse toggle and window resize.
  useEffect(() => {
    const fit = () => setPos((p) => clamp(p, ref.current))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [collapsed])

  function onPointerDown(e) {
    if (e.target.closest('button')) return
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e) {
    if (!drag.current) return
    setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }, ref.current))
  }
  function onPointerUp(e) {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const badge = reconnecting ? 'reconnecting' : callState || 'connecting'
  const duration = openedAt ? fmt(Math.max(0, Math.floor((now - openedAt) / 1000))) : '00:00'

  return (
    <div
      ref={ref}
      className="call-modal panel"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label="Current call"
    >
      <div
        className="call-modal-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <span className="badge" data-state={badge}>{badge}</span>
        <strong className="mono">{duration}</strong>
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
