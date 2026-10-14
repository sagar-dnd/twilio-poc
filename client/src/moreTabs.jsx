/** Audio and conference tabs: Device management and Conference call (kept apart so tabs.jsx stays readable). */
import { useEffect, useRef, useState } from 'react'
import { useMicMeter, useSpeakerTest } from './hooks'
import { CONFERENCE_POLL_MS, E164, getConferenceConfig, getConferenceStatus, selectedOrEmpty } from './lib'
import { Badge, Meter } from './ui'

// --- Device management -------------------------------------------------------------------------

/**
 * Mic / speaker / ringtone selection with live meters and a speaker test.
 * @param {{ twilio: import('./useTwilioDevice').TwilioDevice, active: boolean }} props  active: tab is visible (runs the idle mic meter only then)
 */
export function DeviceManagementTab({ twilio, active }) {
  const registered = twilio.deviceState === 'registered'
  const mic = useMicMeter({
    enabled: active && registered && !twilio.activeCall,
    inputId: twilio.selectedInput,
    releaseNow: Boolean(twilio.activeCall) || !registered,
    log: twilio.log,
  })
  const speaker = useSpeakerTest({ outputId: twilio.selectedOutput, fallbackTest: twilio.testSpeaker, log: twilio.log })

  return (
    <>
      <section className="panel">
        <h2>Device management</h2>
        <p className="hint">
          Mic: <code>device.audio.setInputDevice</code>. Speaker: <code>speakerDevices.set</code>. Ringtone:{' '}
          <code>ringtoneDevices.set</code>. All apply live, including mid-call. The list refreshes on the SDK{' '}
          <code>deviceChange</code> event. If the active mic is unplugged we fall back to the <code>default</code> mic
          automatically. Every change is logged with source <code>audio</code>.
        </p>
        <label>
          Microphone (input)
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
          Speaker (call audio)
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
        <label>
          Ringtone output
          <select
            value={selectedOrEmpty(twilio.selectedRingtone, twilio.outputDevices)}
            onChange={(e) => twilio.setRingtoneDevice(e.target.value)}
            disabled={twilio.deviceState !== 'registered' || !twilio.outputSelectionSupported}
          >
            <option value="">Select ringtone device</option>
            {twilio.outputDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        {!twilio.outputSelectionSupported && twilio.deviceState === 'registered' && (
          <p className="hint">
            This browser does not support output device selection (speaker/ringtone use the system default).
          </p>
        )}
        <dl className="meta">
          <div>
            <dt>Mic (input) level {twilio.activeCall ? '· from call' : '· idle meter'}</dt>
            <dd>
              <Meter value={twilio.activeCall ? twilio.health.inputLevel : Math.max(mic.level, twilio.micLevel)} />
            </dd>
          </div>
          <div>
            <dt>Speaker (output) level {speaker.testing ? '· test tone' : twilio.activeCall ? '· from call' : ''}</dt>
            <dd>
              <Meter
                value={speaker.testing ? speaker.level : twilio.activeCall ? (twilio.health.outputLevel ?? 0) : 0}
              />
            </dd>
          </div>
        </dl>
        <div className="row">
          {(mic.trackMuted || mic.silent || (twilio.activeCall && twilio.health.micDead)) && (
            <Badge tone="error">Mic muted / silent{mic.trackMuted ? ' (track muted)' : ''}</Badge>
          )}
          {speaker.testing && speaker.level <= 0.01 && <Badge tone="warn">Measuring…</Badge>}
          {!speaker.testing && speaker.noOutput && <Badge tone="error">No output detected</Badge>}
          {speaker.mutedWarn && (
            <Badge tone="warn">
              Speaker may be muted or volume at 0, check system volume or the selected output device
            </Badge>
          )}
        </div>
        {speaker.heardPrompt && (
          <div className="banner incoming" role="status">
            <span>Did you hear the test tone?</span>
            <button type="button" onClick={() => speaker.answerHeard(true)}>
              Yes
            </button>
            <button type="button" className="ghost" onClick={() => speaker.answerHeard(false)}>
              No
            </button>
          </div>
        )}
        <div className="row">
          <button type="button" disabled={twilio.deviceState !== 'registered' || speaker.testing} onClick={speaker.run}>
            {speaker.testing ? 'Testing…' : 'Test speaker'}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={twilio.deviceState !== 'registered'}
            onClick={twilio.refreshDevices}
          >
            Refresh list
          </button>
        </div>
      </section>
      <section className="panel">
        <h2>Current devices</h2>
        {twilio.inputDevices.length + twilio.outputDevices.length === 0 && (
          <p className="hint">Register the Device to list audio devices.</p>
        )}
        <ul className="device-list">
          {twilio.inputDevices.map((d) => (
            <li key={`in-${d.id}`} data-active={d.id === twilio.selectedInput}>
              <span className="lvl">mic</span> {d.label}
              {d.id === twilio.selectedInput && <Badge>active</Badge>}
            </li>
          ))}
          {twilio.outputDevices.map((d) => (
            <li key={`out-${d.id}`} data-active={d.id === twilio.selectedOutput || d.id === twilio.selectedRingtone}>
              <span className="lvl">out</span> {d.label}
              {d.id === twilio.selectedOutput && <Badge>speaker</Badge>}
              {d.id === twilio.selectedRingtone && <Badge>ringtone</Badge>}
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

// --- Conference call ---------------------------------------------------------------------------

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
 * Conference call (agent Wi-Fi drop) demo. Agent and customer are separate legs in a
 * <Conference>, so the customer survives the agent's leg dropping (server/index.js /agent-drop/*).
 * @param {{
 *   twilio: import('./useTwilioDevice').TwilioDevice,
 *   room: string | null,
 *   setRoom: (room: string) => void,
 * }} props
 */
export function ConferenceCallTab({ twilio, room, setRoom }) {
  const [to, setTo] = useState('')
  const [config, setConfig] = useState(null)
  const [message, setMessage] = useState('')
  const [grace, setGrace] = useState(0)
  const [session, setSession] = useState(null)
  const [starting, setStarting] = useState(false)
  const seenRef = useRef(0)
  const log = twilio.log

  useEffect(() => {
    getConferenceConfig()
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
        const s = await getConferenceStatus(room)
        if (!s || stop) return
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
    const t = setInterval(tick, CONFERENCE_POLL_MS)
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
          With a plain <code>&lt;Dial&gt;&lt;Number&gt;</code>, the customer leg dies with the browser leg. Here the
          agent and customer join a <code>&lt;Conference&gt;</code>. If the agent leaves unexpectedly, the server
          redirects the customer to hold music (grace) and/or the message below, then hangs up.
        </p>
        <ol className="hint">
          <li>
            Register the Device, enter the customer's number, click <strong>Start resilient call</strong>.
          </li>
          <li>
            After the customer answers, <strong>turn off Wi-Fi</strong> on this machine.
          </li>
          <li>
            The agent leg drops once Twilio gives up on it (the SDK first tries to reconnect for up to ~30s). The
            customer then hears hold music for the grace time (if set), then the message.
          </li>
          <li>
            With a grace time, turn Wi-Fi back on and click <strong>Rejoin</strong> before it runs out.
          </li>
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
          Hang up from the call window (it tells the server the hang-up is intentional, so the customer is not played
          the message).
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
              <div>
                <dt>State</dt>
                <dd>{session.state}</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{session.outcome || '—'}</dd>
              </div>
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
