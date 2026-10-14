/**
 * 0..1 level meter.
 * @param {{ value: number }} props
 */
export default function Meter({ value }) {
  return <meter min="0" max="1" value={value} />
}
