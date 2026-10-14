import { useCallback, useState } from 'react'

/**
 * Active tab mirrored in the URL hash so a reload or shared link opens the same tab.
 * @param {string[]} validIds
 * @param {string} fallback
 * @returns {[string, (id: string) => void]}
 */
export function useHashTab(validIds, fallback) {
  const [tab, setTab] = useState(() => {
    const fromHash = window.location.hash.slice(1)
    return validIds.includes(fromHash) ? fromHash : fallback
  })

  const selectTab = useCallback((id) => {
    // replaceState: switching tabs shouldn't flood the back-button history.
    window.history.replaceState(null, '', `#${id}`)
    setTab(id)
  }, [])

  return [tab, selectTab]
}
