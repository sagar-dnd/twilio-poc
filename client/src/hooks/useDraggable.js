import { useEffect, useRef, useState } from 'react'

const MARGIN = 8

function clampToViewport(pos, el) {
  const w = el?.offsetWidth ?? 300
  const h = el?.offsetHeight ?? 160
  return {
    x: Math.min(Math.max(MARGIN, pos.x), Math.max(MARGIN, window.innerWidth - w - MARGIN)),
    y: Math.min(Math.max(MARGIN, pos.y), Math.max(MARGIN, window.innerHeight - h - MARGIN)),
  }
}

/**
 * Pointer-event dragging for a fixed-position element, kept inside the viewport.
 * @param {{ initial: () => { x: number, y: number }, refitKey?: unknown }} opts
 *   refitKey: re-clamp when it changes (e.g. the element was collapsed/expanded).
 */
export function useDraggable({ initial, refitKey }) {
  const ref = useRef(/** @type {HTMLElement | null} */ (null))
  const dragOffset = useRef(null)
  const [pos, setPos] = useState(initial)

  useEffect(() => {
    const fit = () => setPos((p) => clampToViewport(p, ref.current))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [refitKey])

  /** Spread onto the drag handle. Buttons inside the handle stay clickable. */
  const handleProps = {
    onPointerDown(e) {
      if (e.target.closest('button')) return
      dragOffset.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove(e) {
      if (!dragOffset.current) return
      const next = { x: e.clientX - dragOffset.current.dx, y: e.clientY - dragOffset.current.dy }
      setPos(clampToViewport(next, ref.current))
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  }

  function endDrag(e) {
    dragOffset.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return { ref, style: { left: pos.x, top: pos.y }, handleProps }
}
