import { useEffect } from 'react'

/** Ask the browser to confirm refresh/close while `armed` (the browser shows its own dialog). */
export function useLeaveWarning(armed) {
  useEffect(() => {
    if (!armed) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [armed])
}
