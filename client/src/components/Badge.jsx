/**
 * Pill/tag. Extra props (title, data-state, key…) pass through to the element.
 * @param {{ tone?: 'warn' | 'error', as?: 'span' | 'p', children?: import('react').ReactNode } & Record<string, unknown>} props
 */
export default function Badge({ tone, as: Tag = 'span', children, ...rest }) {
  return (
    <Tag className={tone ? `badge ${tone}` : 'badge'} {...rest}>
      {children}
    </Tag>
  )
}
