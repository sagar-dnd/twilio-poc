import { useCallback, useState } from 'react'
import { LOG_LIMIT } from '../../lib/constants'

/**
 * @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel
 * @typedef {{ id: string, ts: string, level: LogLevel, source: string, msg: string, detail?: string }} LogEntry
 * @typedef {(level: LogLevel, msg: string, detail?: unknown, source?: string) => void} LogFn
 */

function stringifyDetail(detail) {
  if (detail == null) return undefined
  return typeof detail === 'string' ? detail : JSON.stringify(detail)
}

/** Bounded, newest-first event log shared by every hook and tab. */
export function useEventLog() {
  const [logs, setLogs] = useState(/** @type {LogEntry[]} */ ([]))

  /** @type {LogFn} */
  const log = useCallback((level, msg, detail, source = 'app') => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString().slice(11, 23),
      level,
      source,
      msg,
      detail: stringifyDetail(detail),
    }
    setLogs((prev) => [entry, ...prev].slice(0, LOG_LIMIT))
  }, [])

  const clearLogs = useCallback(() => setLogs([]), [])

  return { logs, log, clearLogs }
}
