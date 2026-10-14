/**
 * Horizontal tab bar.
 * @param {{ tabs: { id: string, label: string }[], active: string, onSelect: (id: string) => void }} props
 */
export default function Tabs({ tabs, active, onSelect }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          className={active === id ? 'tab active' : 'tab'}
          onClick={() => onSelect(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  )
}

/**
 * Keeps every tab mounted (state and the shared call survive tab switches); hides inactive ones.
 * @param {{ id: string, active: string, children: import('react').ReactNode }} props
 */
export function TabPane({ id, active, children }) {
  return (
    <div className="tab-pane" hidden={active !== id}>
      {children}
    </div>
  )
}
