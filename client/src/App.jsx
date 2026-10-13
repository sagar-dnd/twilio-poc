import { useEffect, useRef, useState } from 'react'
import { useTwilioDevice } from './useTwilioDevice'
import { usePreflight, summarizeReport } from './usePreflight'
import './App.css'

const E164 = /^\+[1-9]\d{6,14}$/
const DISPOSITIONS = ['answered', 'no_answer', 'busy', 'voicemail', 'declined', 'unavailable', 'failed']
const LOG_SOURCES = ['all', 'preflight', 'device', 'call', 'audio', 'network', 'app']

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export default function App() {
  const [identity, setIdentity] = useState('agent-poc')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [numbers, setNumbers] = useState(['', '', '', '', ''])
  const [coolOffSec, setCoolOffSec] = useState(5)
  const [loopRunning, setLoopRunning] = useState(false)
  const [loopIndex, setLoopIndex] = useState(-1)
  const [loopPhase, setLoopPhase] = useState('idle')
  const [coolLeft, setCoolLeft] = useState(0)
  const [pendingEnd, setPendingEnd] = useState(null)
  const [results, setResults] = useState([])
  const stopRef = useRef(false)
  const dispWaitRef = useRef(null)

  const twilio = useTwilioDevice(identity)
  const [logFilter, setLogFilter] = useState('all')
  const preflight = usePreflight(identity, twilio.log)
  const pf = summarizeReport(preflight.report)
  const visibleLogs = logFilter === 'all' ? twilio.logs : twilio.logs.filter((e) => e.source === logFilter)

  async function onPushTransfer(status) {
    const callSid = twilio.activeCall?.sid
    if (!callSid) return
    await fetch('/demo/push-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callSid, content: { type: 'transfer', status } }),
    })
  }

  // Warn before refresh/close during dialer work (browser shows its own confirm dialog)
  useEffect(() => {
    const armed =
      loopRunning ||
      !!twilio.activeCall ||
      !!twilio.incomingCall ||
      !!pendingEnd ||
      twilio.deviceState === 'registered'
    if (!armed) return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [
    loopRunning,
    pendingEnd,
    twilio.activeCall,
    twilio.incomingCall,
    twilio.deviceState,
  ])

  async function onRegister() {
    setBusy(true)
    try {
      await twilio.register()
    } finally {
      setBusy(false)
    }
  }

  async function onCall() {
    setBusy(true)
    try {
      await twilio.connect({ to: to.trim() })
    } catch (e) {
      /* logged in hook */
    } finally {
      setBusy(false)
    }
  }

  async function onRingInbound() {
    setBusy(true)
    try {
      const res = await fetch('/demo/ring-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || `ring ${res.status}`)
    } catch (e) {
      alert(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  function pickDisposition(d) {
    const wait = dispWaitRef.current
    dispWaitRef.current = null
    setPendingEnd(null)
    wait?.(d)
  }

  async function waitDisposition() {
    return new Promise((resolve) => {
      dispWaitRef.current = resolve
    })
  }

  async function runPowerLoop() {
    const list = numbers.map((n) => n.trim())
    if (list.some((n) => !E164.test(n))) {
      alert('Enter 5 valid E.164 numbers')
      return
    }
    stopRef.current = false
    setResults([])
    setLoopRunning(true)
    const coolMs = Math.max(0, Number(coolOffSec) || 0) * 1000

    for (let i = 0; i < list.length; i += 1) {
      if (stopRef.current) break
      setLoopIndex(i)
      setLoopPhase('calling')
      const end = await twilio.connectUntilEnd({ to: list[i] })
      if (stopRef.current) break
      setLoopPhase('disposition')
      setPendingEnd({ to: list[i], ...end })
      const disposition = await waitDisposition()
      if (stopRef.current || disposition === 'stopped') break
      setResults((prev) => [
        ...prev,
        {
          to: list[i],
          disposition,
          sdk: end.reason + (end.error ? ` ${end.error}` : ''),
          at: new Date().toLocaleTimeString(),
        },
      ])
      if (i < list.length - 1 && coolMs > 0 && !stopRef.current) {
        setLoopPhase('cooloff')
        for (let s = Math.ceil(coolMs / 1000); s > 0; s -= 1) {
          if (stopRef.current) break
          setCoolLeft(s)
          await sleep(1000)
        }
        setCoolLeft(0)
      }
    }

    setLoopPhase('idle')
    setLoopIndex(-1)
    setLoopRunning(false)
    setPendingEnd(null)
  }

  function stopPowerLoop() {
    stopRef.current = true
    twilio.hangup()
    pickDisposition('stopped')
    setLoopRunning(false)
    setLoopPhase('idle')
    setCoolLeft(0)
  }

  return (
    <div className="app">
      <header>
        <h1>Twilio Voice POC</h1>
        <p className="sub">SD-7331 — Device lifecycle, calls, audio, token refresh &amp; recovery</p>
      </header>

      {twilio.error && (
        <div className="banner error" role="alert">
          <span>{twilio.error}</span>
          <button type="button" onClick={twilio.clearError}>
            dismiss
          </button>
        </div>
      )}

      {twilio.incomingCall && (
        <div className="banner incoming" role="status">
          <span>Incoming from {twilio.incomingCall.parameters?.From || 'unknown'}</span>
          <button type="button" onClick={twilio.acceptIncoming}>
            Accept
          </button>
          <button type="button" className="ghost" onClick={twilio.rejectIncoming}>
            Reject
          </button>
          <button type="button" className="ghost" onClick={twilio.ignoreIncoming}>
            Ignore
          </button>
        </div>
      )}

      <section className="panel">
        <h2>0. Network test (Preflight)</h2>
        <p className="hint">
          Run before going Available (pre-shift) or after network issues. Places a ~20s test call via{' '}
          <code>Device.runPreflight</code>.
        </p>
        <div className="row">
          <button
            type="button"
            disabled={['connecting', 'connected'].includes(preflight.status) || !!twilio.activeCall}
            onClick={preflight.run}
          >
            Run network test
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!['connecting', 'connected'].includes(preflight.status)}
            onClick={preflight.stop}
          >
            Stop
          </button>
          <span className="badge" data-state={preflight.status}>
            {preflight.status}
            {['connecting', 'connected'].includes(preflight.status) && ` · ${preflight.elapsedSec}s`}
          </span>
        </div>
        {preflight.latest && preflight.status === 'connected' && (
          <p className="hint mono">
            live: MOS {preflight.latest.mos?.toFixed?.(2) ?? '—'} · RTT {preflight.latest.rtt ?? '—'}ms · jitter{' '}
            {preflight.latest.jitter ?? '—'} · loss {preflight.latest.packetsLostFraction ?? '—'}%
          </p>
        )}
        {pf && (
          <dl className="meta">
            <div><dt>Call quality</dt><dd><strong>{pf.callQuality}</strong></dd></div>
            <div><dt>MOS (avg)</dt><dd>{pf.mos}</dd></div>
            <div><dt>RTT (avg)</dt><dd>{pf.rtt}</dd></div>
            <div><dt>Jitter (avg)</dt><dd>{pf.jitter}</dd></div>
            <div><dt>Packet loss</dt><dd>{pf.packetLoss}</dd></div>
            <div><dt>ICE candidate</dt><dd>{pf.iceCandidate}</dd></div>
            <div><dt>TURN required</dt><dd>{pf.turnRequired}</dd></div>
            <div><dt>Edge</dt><dd>{pf.edge}</dd></div>
            <div><dt>Signaling</dt><dd>{pf.signalingMs} ms</dd></div>
            <div><dt>Test duration</dt><dd>{pf.durationSec}s</dd></div>
          </dl>
        )}
        {preflight.warnings.length > 0 && (
          <div className="row">
            {preflight.warnings.map((w, i) => (
              <span key={`${w.name}-${i}`} className="badge warn" title={w.description}>
                {w.name}
              </span>
            ))}
          </div>
        )}
        {preflight.failure && <p className="badge error">Failed: {preflight.failure}</p>}
      </section>

      <section className="panel">
        <h2>1. Device</h2>
        <label>
          Identity
          <input
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            disabled={twilio.deviceState === 'registered'}
            autoComplete="off"
          />
        </label>
        <div className="row">
          <button type="button" disabled={busy || twilio.deviceState === 'registered'} onClick={onRegister}>
            Register Device
          </button>
          <button
            type="button"
            className="ghost"
            disabled={twilio.deviceState === 'unregistered'}
            onClick={twilio.unregister}
          >
            Unregister / Destroy
          </button>
        </div>
        <dl className="meta">
          <div>
            <dt>State</dt>
            <dd data-state={twilio.deviceState}>{twilio.deviceState}</dd>
          </div>
          <div>
            <dt>Token TTL</dt>
            <dd>{twilio.tokenMeta ? `${twilio.tokenMeta.ttl}s` : '—'}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>
              {twilio.tokenMeta
                ? new Date(twilio.tokenMeta.expiresAt).toLocaleTimeString()
                : '—'}
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>2a. Incoming call</h2>
        <p className="hint">
          Device must be <strong>registered</strong>. Click Ring, or call your Twilio number after
          pointing its Voice URL to public <code>POST /voice/inbound?identity={identity}</code>.
        </p>
        <div className="row">
          <button
            type="button"
            disabled={busy || twilio.deviceState !== 'registered'}
            onClick={onRingInbound}
          >
            Ring this identity (REST inbound)
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>2b. Place outbound call</h2>
        <p className="hint">
          Outbound hits TwiML App <code>POST /voice</code>. Destination must be E.164 (e.g.{' '}
          <code>+15551234567</code>). Trial accounts can only call verified numbers.
        </p>
        <label>
          To (E.164)
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="+15551234567"
            inputMode="tel"
            autoComplete="tel"
          />
        </label>
        <div className="row">
          <button
            type="button"
            disabled={
              busy ||
              loopRunning ||
              twilio.deviceState !== 'registered' ||
              twilio.activeCall ||
              !E164.test(to.trim())
            }
            onClick={onCall}
          >
            Connect
          </button>
          <button type="button" className="ghost" disabled={!twilio.activeCall} onClick={twilio.hangup}>
            Hang up
          </button>
          <button type="button" className="ghost" disabled={!twilio.activeCall} onClick={twilio.toggleMute}>
            {twilio.muted ? 'Unmute' : 'Mute'}
          </button>
        </div>
        <dl className="meta">
          <div>
            <dt>Call</dt>
            <dd>{twilio.callState || 'idle'}</dd>
          </div>
          <div>
            <dt>SID</dt>
            <dd className="mono">{twilio.activeCall?.sid || '—'}</dd>
          </div>
          <div>
            <dt>Direction</dt>
            <dd>{twilio.activeCall?.direction || '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>2b. Call health &amp; scenarios</h2>
        <div className="row">
          {twilio.health.reconnecting && <span className="badge warn">Reconnecting…</span>}
          {twilio.health.micDead && <span className="badge error">Mic silent 5s — check mic</span>}
          {twilio.health.earlyMedia && twilio.callState === 'ringing' && (
            <span className="badge">Early media (carrier audio)</span>
          )}
          {twilio.health.warnings.map((w) => (
            <span key={w} className="badge warn">
              {w}
            </span>
          ))}
        </div>
        <dl className="meta">
          <div>
            <dt>Mic level</dt>
            <dd>
              <meter min="0" max="1" value={twilio.health.inputLevel} />
            </dd>
          </div>
          <div>
            <dt>MOS / RTT / jitter / loss</dt>
            <dd className="mono">
              {twilio.health.quality
                ? `${twilio.health.quality.mos ?? '—'} / ${twilio.health.quality.rtt ?? '—'}ms / ${twilio.health.quality.jitter ?? '—'} / ${twilio.health.quality.packetsLostFraction ?? '—'}%`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>AMD</dt>
            <dd>{twilio.health.amd || '—'}</dd>
          </div>
          <div>
            <dt>Carrier leg</dt>
            <dd>{twilio.health.carrier || '—'}</dd>
          </div>
          <div>
            <dt>Transfer</dt>
            <dd>{twilio.health.transfer || '—'}</dd>
          </div>
          <div>
            <dt>Last end</dt>
            <dd className="mono">
              {twilio.lastEnd
                ? `${twilio.lastEnd.reason}${twilio.lastEnd.code ? ` ${twilio.lastEnd.code}` : ''} → ${twilio.lastEnd.disposition || '—'}`
                : '—'}
            </dd>
          </div>
        </dl>
        <label>
          No-answer timeout (seconds, 0 = off)
          <input
            type="number"
            min="0"
            max="120"
            value={twilio.ringTimeoutSec}
            onChange={(e) => twilio.setRingTimeoutSec(e.target.value)}
          />
        </label>
        <label>
          Token TTL override for next Register (seconds, min 60; empty = server default)
          <input
            type="number"
            min="60"
            value={twilio.shortTtl ?? ''}
            onChange={(e) => twilio.setShortTtl(e.target.value ? Number(e.target.value) : null)}
            disabled={twilio.deviceState === 'registered'}
          />
        </label>
        <div className="row">
          <button type="button" className="ghost" disabled={!twilio.activeCall} onClick={() => onPushTransfer('ringing')}>
            Push transfer: ringing
          </button>
          <button type="button" className="ghost" disabled={!twilio.activeCall} onClick={() => onPushTransfer('completed')}>
            Push transfer: completed
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!twilio.activeCall}
            onClick={() => twilio.sendMessage({ type: 'agent-note', text: 'hello from agent' })}
          >
            Send message (messageSent)
          </button>
        </div>
        {twilio.missedCalls.length > 0 && (
          <>
            <h3>Missed inbound</h3>
            <ul>
              {twilio.missedCalls.map((m, i) => (
                <li key={`${m.from}-${m.at}-${i}`}>
                  {m.at} {m.from || 'unknown'} (caller hung up)
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="panel">
        <h2>2c. Power loop — 5 numbers</h2>
        <p className="hint">
          Calls one E.164 number at a time. After hangup, pick a disposition, then cool-off before the
          next dial. Stop cancels the queue.
        </p>
        {numbers.map((n, i) => (
          <label key={i}>
            {i + 1}
            <input
              value={n}
              onChange={(e) =>
                setNumbers((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
              }
              placeholder="+15551234567"
              inputMode="tel"
              disabled={loopRunning}
            />
          </label>
        ))}
        <label>
          Cool-off (seconds)
          <input
            type="number"
            min="0"
            max="120"
            value={coolOffSec}
            onChange={(e) => setCoolOffSec(e.target.value)}
            disabled={loopRunning}
          />
        </label>
        <div className="row">
          <button
            type="button"
            disabled={loopRunning || twilio.deviceState !== 'registered'}
            onClick={runPowerLoop}
          >
            Start 5-number loop
          </button>
          <button type="button" className="ghost" disabled={!loopRunning} onClick={stopPowerLoop}>
            Stop loop
          </button>
          {loopRunning && (
            <span className="hint">
              {loopPhase === 'calling' && `Calling ${loopIndex + 1}/5`}
              {loopPhase === 'disposition' && `Set disposition for ${loopIndex + 1}/5`}
              {loopPhase === 'cooloff' && `Cool-off ${coolLeft}s before ${loopIndex + 2}/5`}
            </span>
          )}
        </div>
        {pendingEnd && (
          <div className="banner incoming" role="status">
            <span>
              {pendingEnd.to} ended ({pendingEnd.reason}
              {pendingEnd.error ? `: ${pendingEnd.error}` : ''}).
              {pendingEnd.disposition && <strong> Suggested: {pendingEnd.disposition}.</strong>} Disposition:
            </span>
            {DISPOSITIONS.map((d) => (
              <button key={d} type="button" onClick={() => pickDisposition(d)}>
                {d}
              </button>
            ))}
          </div>
        )}
        {results.length > 0 && (
          <table className="results">
            <thead>
              <tr>
                <th>#</th>
                <th>Number</th>
                <th>Disposition</th>
                <th>SDK</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={`${r.to}-${r.at}-${i}`}>
                  <td>{i + 1}</td>
                  <td className="mono">{r.to}</td>
                  <td>{r.disposition}</td>
                  <td>{r.sdk}</td>
                  <td>{r.at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>3. Audio devices</h2>
        <p className="hint">
          Input: <code>setInputDevice</code>. Output: speaker + ringtone both follow this dropdown
          (Chrome/Edge). Change it while ringing to move the ring off earphones.
        </p>
        <label>
          Input (microphone)
          <select
            value={selectedOrEmpty(twilio.selectedInput, twilio.inputDevices)}
            onChange={(e) => twilio.setInputDevice(e.target.value)}
            disabled={twilio.deviceState !== 'registered'}
          >
            <option value="">Select mic</option>
            {twilio.inputDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Output (speaker)
          <select
            value={selectedOrEmpty(twilio.selectedOutput, twilio.outputDevices)}
            onChange={(e) => twilio.setOutputDevice(e.target.value)}
            disabled={twilio.deviceState !== 'registered' || !twilio.outputSelectionSupported}
          >
            <option value="">Select speaker</option>
            {twilio.outputDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {!twilio.outputSelectionSupported && twilio.deviceState === 'registered' && (
          <p className="hint">This browser does not support Twilio output device selection.</p>
        )}
      </section>

      <section className="panel">
        <h2>4. Failure / recovery demos</h2>
        <p className="hint">
          Token auto-refreshes on <code>tokenWillExpire</code>. Inject an invalid token, then try Connect
          or wait for a device error. Unregister cleans up; Register recovers.
        </p>
        <div className="row">
          <button
            type="button"
            className="danger"
            disabled={twilio.deviceState !== 'registered'}
            onClick={twilio.simulateExpiredToken}
          >
            Inject invalid token
          </button>
          <button type="button" className="ghost" onClick={twilio.clearLogs}>
            Clear log
          </button>
        </div>
      </section>

      <section className="panel log-panel">
        <h2>Event log</h2>
        <div className="row">
          {LOG_SOURCES.map((src) => (
            <button
              key={src}
              type="button"
              className={logFilter === src ? '' : 'ghost'}
              onClick={() => setLogFilter(src)}
            >
              {src}
            </button>
          ))}
        </div>
        <ul className="log">
          {visibleLogs.length === 0 && <li className="empty">No events yet</li>}
          {visibleLogs.map((e) => (
            <li key={e.id} data-level={e.level}>
              <time>{e.ts}</time>
              <span className="lvl">{e.level}</span>
              <span className="lvl">{e.source}</span>
              <span>{e.msg}</span>
              {e.detail && <code>{e.detail}</code>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function selectedOrEmpty(selected, list) {
  if (selected && list.some((d) => d.id === selected)) return selected
  return ''
}
