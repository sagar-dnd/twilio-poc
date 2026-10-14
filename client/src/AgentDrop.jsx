import { useEffect, useRef, useState } from 'react'

const E164 = /^\+[1-9]\d{6,14}$/

const STEPS = [
  ['agent-joined', 'Agent joined conference'],
  ['customer-joined', 'Customer joined'],
  ['agent-left (unexpected)', 'Agent left (unexpected)'],
  ['customer-on-hold', 'Customer on hold (grace)'],
  ['agent-rejoined', 'Agent rejoined'],
  ['customer-hearing-message', 'Customer hearing message'],
  ['conference-ended', 'Ended'],
]

/**
 * Agent drop (Wi-Fi) demo. Agent + customer are separate legs in a <Conference>
 * so the customer survives the agent's leg dropping (server/index.js /agent-drop/*).
 */
export default function AgentDrop({ twilio, room, setRoom }) {
  const [to, setTo] = useState('')
  const [config, setConfig] = useState(null)
  const [message, setMessage] = useState('')
  const [grace, setGrace] = useState(0)
  const [session, setSession] = useState(null)
  const [starting, setStarting] = useState(false)
  const seenRef = useRef(0)
  const log = twilio.log

  useEffect(() => {
    fetch('/agent-drop/config')
      .then((r) => r.json())
      .then((c) => {
        setConfig(c)
        setMessage(c.message)
        setGrace(c.graceSeconds)
      })
      .catch(() => setConfig({ publicBaseUrlSet: false, error: true }))
  }, [])

  // Poll server-side session state (works again once the agent's network is back).
  useEffect(() => {
    if (!room) return
    let stop = false
    const tick = async () => {
      try {
        const r = await fetch(`/agent-drop/status?room=${room}`)
        if (!r.ok) return
        const s = await r.json()
        if (stop) return
        setSession(s)
        s.timeline.slice(seenRef.current).forEach((e) => {
          const warn = /unexpected|failed|message/.test(e.event)
          log(warn ? 'warn' : 'info', `agent-drop: ${e.event}`, e.detail, 'call')
        })
        seenRef.current = s.timeline.length
      } catch {
        /* offline — retry next tick */
      }
    }
    tick()
    const t = setInterval(tick, 1000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [room, log])

  async function start() {
    const id = `agentdrop-${Date.now().toString(36)}`
    seenRef.current = 0
    setSession(null)
    setRoom(id)
    setStarting(true)
    log('info', 'agent-drop: starting resilient call', `${to} room=${id} grace=${grace}s`, 'call')
    try {
      await twilio.connect({
        to: to.trim(),
        extraParams: { mode: 'conference', room: id, grace: String(grace), message },
      })
    } catch {
      /* logged in hook */
    } finally {
      setStarting(false)
    }
  }

  async function rejoin() {
    log('info', 'agent-drop: rejoining room', room, 'call')
    try {
      await twilio.connect({ to: session?.to || to.trim(), extraParams: { mode: 'conference', room, rejoin: '1' } })
    } catch {
      /* logged in hook */
    }
  }

  const events = new Set((session?.timeline || []).map((e) => e.event))
  const at = (ev) => session?.timeline.find((e) => e.event === ev)?.at
  const ended = session?.state === 'ended'

  return (
    <>
      <section className="panel">
        <h2>Conference call</h2>
        {config && !config.publicBaseUrlSet && (
          <div className="banner error" role="alert">
            <span>
              {config.error ? 'Could not reach the server. ' : ''}
              <code>PUBLIC_BASE_URL</code> is not set. Conference callbacks can't reach the server, so this demo won't
              work. Run <code>ngrok http 3001</code> and set <code>PUBLIC_BASE_URL</code> in <code>.env</code>.
            </span>
          </div>
        )}
        <p className="hint">
          With a plain <code>&lt;Dial&gt;&lt;Number&gt;</code>, the customer leg dies with the browser leg. Here the agent and
          customer join a <code>&lt;Conference&gt;</code>. If the agent leaves unexpectedly, the server redirects the customer
          to hold music (grace) and/or the message below, then hangs up.
        </p>
        <ol className="hint">
          <li>Register the Device, enter the customer's number, click <strong>Start resilient call</strong>.</li>
          <li>After the customer answers, <strong>turn off Wi-Fi</strong> on this machine.</li>
          <li>
            The agent leg drops once Twilio gives up on it (the SDK first tries to reconnect for up to ~30s). The customer then
            hears hold music for the grace time (if set), then the message.
          </li>
          <li>With a grace time, turn Wi-Fi back on and click <strong>Rejoin</strong> before it runs out.</li>
        </ol>
        <label>
          Customer number (E.164)
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+15551234567" inputMode="tel" />
        </label>
        <label>
          Message the customer hears
          <input value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <label>
          Grace period with hold music (seconds, 0 = message immediately)
          <input type="number" min="0" max="120" value={grace} onChange={(e) => setGrace(e.target.value)} />
        </label>
        <div className="row">
          <button
            type="button"
            disabled={starting || twilio.deviceState !== 'registered' || !!twilio.activeCall || !E164.test(to.trim())}
            onClick={start}
          >
            Start resilient call
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!room || ended || !!twilio.activeCall || session?.state !== 'grace'}
            onClick={rejoin}
          >
            Rejoin
          </button>
          {room && <span className="hint mono">room {room}</span>}
        </div>
        <p className="hint">
          Hang up from the call window (it tells the server the hang-up is intentional, so the customer is not played the
          message).
        </p>
      </section>
      <section className="panel">
        <h2>Status timeline</h2>
        {!session && <p className="hint">No resilient call yet.</p>}
        {session && (
          <>
            <ul className="device-list">
              {STEPS.map(([ev, label]) => (
                <li key={ev} data-active={events.has(ev)}>
                  <span className="lvl">{events.has(ev) ? '●' : '○'}</span> {label}
                  {at(ev) && <span className="hint mono">{new Date(at(ev)).toLocaleTimeString()}</span>}
                </li>
              ))}
            </ul>
            <dl className="meta">
              <div><dt>State</dt><dd>{session.state}</dd></div>
              <div><dt>Outcome</dt><dd>{session.outcome || '—'}</dd></div>
            </dl>
            <details>
              <summary className="hint">Raw server timeline</summary>
              <ul className="log">
                {session.timeline.map((e, i) => (
                  <li key={i}>
                    <time>{new Date(e.at).toLocaleTimeString()}</time>
                    <span>{e.event}</span>
                    {e.detail && <code>{e.detail}</code>}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>
    </>
  )
}
