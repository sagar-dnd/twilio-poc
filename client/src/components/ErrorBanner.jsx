/**
 * @param {{ message: string | null, onDismiss: () => void }} props
 */
export default function ErrorBanner({ message, onDismiss }) {
  if (!message) return null
  return (
    <div className="banner error" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  )
}
