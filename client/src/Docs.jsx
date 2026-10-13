import { useEffect, useState } from 'react'

const C = ({ children }) => <code>{children}</code>

/** Each card: scenario, events fired, handling (with real code refs), how to reproduce. Sourced from README + code. */
const TABS = [
  {
    id: 'overview',
    label: 'Overview',
    intro: (
      <>
        <p>
          SD-7331 POC: an Express server (<C>server/index.js</C>) issues Access Tokens and TwiML; the React client uses the{' '}
          <C>@twilio/voice-sdk</C> <C>Device</C> (<C>client/src/useTwilioDevice.js</C>).
        </p>
        <ul>
          <li><b>Client</b> — React + Vite. Device lifecycle, calls, audio and recovery in <C>useTwilioDevice.js</C>; error catalog, disposition mapping, backoff, dead-mic detector and message parsing in <C>twilioEvents.js</C>; network test in <C>usePreflight.js</C>.</li>
          <li><b>Server</b> — <C>GET /token</C>, <C>POST /voice</C> (outbound Dial with <C>answerOnBridge</C>, optional status/AMD callbacks), <C>/voice/inbound</C> (PSTN → browser), <C>/demo/ring-client</C>, <C>/preflight/record</C> + <C>/preflight/playback</C>, <C>/voice/amd</C>, <C>/voice/number-status</C>, <C>/voice/dial-status</C>, <C>/demo/push-message</C>.</li>
          <li><b>TwiML</b> — TwiML App Voice URL → <C>/voice</C>; Twilio number Voice URL → <C>/voice/inbound?identity=…</C>.</li>
        </ul>
        <p>
          <b>Beyond a basic Voice SDK setup:</b> Device options <C>tokenRefreshMs: 30000</C>, <C>maxCallSignalingTimeoutMs: 30000</C>,{' '}
          <C>enableImprovedSignalingErrorPrecision: true</C>, <C>allowIncomingWhileBusy: true</C>, <C>closeProtection</C>; token refresh +
          wake handling; re-register with exponential backoff + jitter; mic fallback and dead-mic detection; suggested dispositions;
          server-pushed user-defined messages (carrier, dial result, AMD, transfer); PreflightTest with a server record/playback flow.
        </p>
      </>
    ),
    cards: [],
  },
  {
    id: 'device',
    label: 'Device & Registration',
    cards: [
      {
        title: 'Token expiry / refresh',
        events: <><C>tokenWillExpire</C>; <C>error</C> 20101 / 20104 / 31204 / 31205</>,
        handling: <>Refetch <C>/token</C> → <C>device.updateToken()</C> (<C>refreshToken</C> in <C>useTwilioDevice.js</C>). Token codes are <C>kind: 'token'</C> in <C>ERROR_CATALOG</C> (<C>twilioEvents.js</C>). <C>tokenRefreshMs: 30000</C> fires the event 30s before expiry.</>,
        repro: <>Set TTL override to 90s, Register, wait ~60s. Or click "Inject invalid token" (<C>simulateExpiredToken</C>) then Connect.</>,
      },
      {
        title: 'Laptop sleep / wake / back online',
        events: <><C>visibilitychange</C>, <C>online</C>, <C>offline</C> (browser)</>,
        handling: <><C>onWake</C> effect in <C>useTwilioDevice.js</C>: if token expires within 60s → <C>refreshToken</C>; if Device not Registered → <C>scheduleReRegister</C>. <C>offline</C> is logged.</>,
        repro: <>Close the lid longer than the token TTL and reopen, or toggle Wi-Fi off/on while registered.</>,
      },
      {
        title: 'Firewall / WebSocket blocked',
        events: <><C>device.error</C> 31005 / 31009 / 53000 / 53001, <C>unregistered</C></>,
        handling: <><C>scheduleReRegister</C> uses <C>backoffMs(attempt)</C> (<C>twilioEvents.js</C>): exponential 1s → 30s cap with jitter; retries until registered, skipped after an intentional unregister.</>,
        repro: <>Block <C>chunderw-vpc-gll.twilio.com</C> / <C>*.twilio.com:443</C> (Little Snitch, <C>/etc/hosts</C>) and Register.</>,
      },
      {
        title: 'Unexpected unregister',
        events: <><C>unregistered</C> without agent action</>,
        handling: <>Handler logs "unexpected" when <C>intentionalUnregisterRef</C> is false and calls <C>scheduleReRegister('unexpected unregister')</C>.</>,
        repro: <>Drop the network while registered; compare with clicking Unregister (logged "by agent", no retry).</>,
      },
    ],
  },
  {
    id: 'outbound',
    label: 'Outbound Calls & Outcomes',
    cards: [
      {
        title: 'Busy / declined / unavailable',
        events: <><C>call.error</C> 31486 / 31603 / 31480 (improved signaling precision)</>,
        handling: <><C>ERROR_CATALOG</C> maps them to Busy / Declined / Unavailable; <C>suggestDisposition</C> uses the code first. Also 31404 → Invalid number, 31408 → No answer.</>,
        repro: <>Call a line already on a call (busy), reject on the phone (declined), phone off / airplane mode (unavailable).</>,
      },
      {
        title: 'No answer timeout',
        events: <>client ring timer → <C>disconnect</C>; <C>&lt;Dial action&gt;</C> <C>no-answer</C></>,
        handling: <>Agent-side ring cap (panel 2b, default 30s) via <C>ringTimerRef</C> in <C>useTwilioDevice.js</C>; reason <C>no-answer-timeout</C> → "No answer". Dial result <C>no-answer</C>/<C>canceled</C> also map to "No answer".</>,
        repro: <>Dial a phone and let it ring.</>,
      },
      {
        title: 'Early media (carrier messages)',
        events: <><C>ringing(hasEarlyMedia=true)</C>; <C>messageReceived</C> <C>{'{type:"carrier"}'}</C></>,
        handling: <>"Early media" badge; audio plays because <C>/voice</C> dials with <C>answerOnBridge: true</C>. With <C>PUBLIC_BASE_URL</C>, <C>/voice/number-status</C> pushes PSTN leg status (incl. SIP response code).</>,
        repro: <>Dial an invalid/disconnected number that plays a carrier announcement.</>,
      },
      {
        title: 'Voicemail / AMD',
        events: <><C>messageReceived</C> <C>{'{type:"amd"}'}</C> from <C>/voice/amd</C></>,
        handling: <>Server enables <C>machineDetection</C> when <C>ENABLE_AMD=true</C>; client shows result; <C>amd === 'machine'</C> → "Voicemail" in <C>suggestDisposition</C>.</>,
        repro: <>Set <C>PUBLIC_BASE_URL</C> (ngrok), dial a phone and let voicemail answer.</>,
      },
      {
        title: 'Hangups & suggested disposition',
        events: <><C>disconnect</C> after <C>accept</C>; <C>messageReceived</C> <C>{'{type:"dial-result"}'}</C></>,
        handling: <><C>suggestDisposition</C>: answered → "Connected (agent hangup)" / "Connected (customer hangup)"; dial result busy/failed map accordingly; error → Failed; reject → Rejected.</>,
        repro: <>Answer on the phone, then hang up from the phone or click Hang up.</>,
      },
    ],
  },
  {
    id: 'inbound',
    label: 'Inbound',
    cards: [
      {
        title: 'Inbound while busy',
        events: <><C>device.incoming</C> while a call is active</>,
        handling: <><C>allowIncomingWhileBusy: true</C>; the <C>incoming</C> handler always rings (no auto-reject) and doesn't replace the active call until accept. Accept ends the current call.</>,
        repro: <>During an outbound call, click "Ring this browser" (<C>/demo/ring-client</C>) or call the Twilio number.</>,
      },
      {
        title: 'Missed (caller cancels)',
        events: <><C>call.cancel</C></>,
        handling: <>Incoming banner removed, entry added to Missed list (last 20), disposition "Missed".</>,
        repro: <>Ring the browser and hang up from the caller before accepting.</>,
      },
      {
        title: 'Ignore',
        events: <><C>call.ignore()</C></>,
        handling: <>Stops local ringing; caller later cancels → Missed.</>,
        repro: <>Click Ignore on the incoming banner.</>,
      },
    ],
  },
  {
    id: 'audio',
    label: 'Audio / Mic',
    cards: [
      {
        title: 'Mic permission denied',
        events: <>getUserMedia <C>NotAllowedError</C>, <C>error</C> 31401</>,
        handling: <>Pre-flight <C>getUserMedia</C> before creating the Device; banner with permission help. 31401 is the v2 code (31208 was v1).</>,
        repro: <>Site settings → Microphone → Block, then Register.</>,
      },
      {
        title: 'Mic busy / unplugged',
        events: <><C>error</C> 31402, <C>device.audio</C> <C>deviceChange(lostActiveDevices)</C></>,
        handling: <><C>deviceChange</C> handler refreshes the picker; if the selected input was lost → <C>setInputDevice('default')</C>, otherwise shows an error.</>,
        repro: <>Unplug a USB/BT headset mid-call, or select a mic another app holds exclusively.</>,
      },
      {
        title: 'Dead mic (no audio)',
        events: <><C>call.volume</C></>,
        handling: <><C>createMicDeadDetector</C> (<C>twilioEvents.js</C>): input ≤ 0.001 for 5s while unmuted → "Mic silent" badge; clears on recovery.</>,
        repro: <>Mid-call, set OS input volume to 0 (or pick a muted hardware mic).</>,
      },
    ],
  },
  {
    id: 'network',
    label: 'Network & Quality',
    cards: [
      {
        title: 'Reconnecting / signaling timeout',
        events: <><C>call.reconnecting</C> / <C>reconnected</C>, <C>disconnect</C> after 30s</>,
        handling: <>"Reconnecting…" badge; call kept up to <C>maxCallSignalingTimeoutMs</C> (30s).</>,
        repro: <>Mid-call, toggle Wi-Fi off 5–10s then on (or switch Wi-Fi → hotspot).</>,
      },
      {
        title: 'Media failure (ICE)',
        events: <><C>error</C> 53405 (v1: 31003)</>,
        handling: <>Catalogued as network: end call, suggest TURN/network check.</>,
        repro: <>Restrictive network blocking UDP/TURN.</>,
      },
      {
        title: 'Quality warnings & MOS',
        events: <><C>sample</C>, <C>warning</C> / <C>warning-cleared</C> (high-rtt, high-jitter, high-packet-loss, low-mos, constant-audio-input-level…)</>,
        handling: <>MOS/RTT/jitter/loss row + warning badges in panel 2b; samples logged every 10s.</>,
        repro: <>macOS Network Link Conditioner ("Very Bad Network") mid-call.</>,
      },
    ],
  },
  {
    id: 'preflight',
    label: 'Preflight',
    cards: [
      {
        title: 'PreflightTest',
        events: <><C>connected</C>, <C>sample</C>, <C>warning</C>, <C>completed</C>, <C>failed</C></>,
        handling: <><C>Device.runPreflight</C> in <C>usePreflight.js</C>; shows quality rating, avg MOS/RTT/jitter, packet loss, ICE candidate, TURN, edge, signaling time. Stop → <C>failed</C> 31008. Disabled during a live call. Token from <C>/token?purpose=preflight</C> (uses <C>TWILIO_PREFLIGHT_TWIML_APP_SID</C> if set).</>,
        repro: <>Panel 0 → Run. Run pre-shift, after network issues, or after changing Wi-Fi/VPN.</>,
      },
      {
        title: 'Server record / playback',
        events: <>TwiML: <C>/voice</C> without <C>To</C> → redirect</>,
        handling: <><C>/preflight/record</C>: countdown + <C>&lt;Record maxLength=5 timeout=3&gt;</C>; <C>/preflight/playback</C> plays the recording, pauses 10s for metrics, hangs up (says so if nothing recorded).</>,
        repro: <>Run preflight and speak after "3, 2, 1"; you should hear yourself back. Each test is a real ~20s call.</>,
      },
    ],
  },
  {
    id: 'messages',
    label: 'Server Messages / Transfer',
    cards: [
      {
        title: 'User-defined messages',
        events: <><C>messageReceived</C> <C>{'{type: amd | carrier | dial-result | transfer}'}</C>, <C>messageSent</C></>,
        handling: <>Server <C>pushToClient</C> → <C>calls(parent).userDefinedMessages.create</C>; client <C>parseUserMessage</C> (<C>twilioEvents.js</C>) parses JSON (plain text → <C>type: 'text'</C>). <C>messageSent</C> logged with <C>voiceEventSid</C>.</>,
        repro: <>Needs <C>ngrok http 3001</C> + <C>PUBLIC_BASE_URL</C>. Mid-call, click "Send message".</>,
      },
      {
        title: 'Push transfer status',
        events: <><C>messageReceived</C> <C>{'{type:"transfer"}'}</C></>,
        handling: <><C>POST /demo/push-message</C> with <C>{'{callSid, content}'}</C>; client shows transfer status.</>,
        repro: <>Mid-call, click "Push transfer: ringing/completed".</>,
      },
    ],
  },
  {
    id: 'failures',
    label: 'Failure Demos',
    cards: [
      { title: 'Invalid token', events: <>20101 / 31204</>, handling: <>Token refresh path.</>, repro: <>Register → "Inject invalid token" → Connect.</> },
      { title: 'Short TTL', events: <><C>tokenWillExpire</C></>, handling: <><C>updateToken</C>.</>, repro: <>TTL override 90s, wait ~60s.</> },
      { title: 'Network drop', events: <><C>reconnecting</C> / <C>unregistered</C></>, handling: <>Reconnect window / backoff re-register.</>, repro: <>Toggle Wi-Fi mid-call or while idle.</> },
      { title: 'Blocked WebSocket', events: <>31005 / 31009 / 53000</>, handling: <>Backoff re-register.</>, repro: <>Block <C>*.twilio.com:443</C>, Register.</> },
      { title: 'Mic blocked / unplugged / silent', events: <>31401 / 31402 / <C>volume</C></>, handling: <>Banner / default fallback / "Mic silent".</>, repro: <>Block mic; unplug headset; OS input volume 0.</> },
      { title: 'Callee outcomes', events: <>31486 / 31603 / 31480</>, handling: <>Dispositions.</>, repro: <>Busy line, reject, phone off.</> },
      { title: 'Bad network quality', events: <><C>warning</C></>, handling: <>Badges + MOS row.</>, repro: <>Network Link Conditioner.</> },
      { title: 'Disconnect / re-register', events: <><C>unregistered</C>, <C>registered</C></>, handling: <>Cleanup and re-create.</>, repro: <>Hang up; Unregister then Register.</> },
    ],
  },
]

function tabFromHash() {
  const id = window.location.hash.replace('#', '')
  return TABS.some((t) => t.id === id) ? id : TABS[0].id
}

export default function Docs() {
  const [active, setActive] = useState(tabFromHash)
  useEffect(() => {
    const onHash = () => setActive(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const tab = TABS.find((t) => t.id === active)

  return (
    <div className="app docs">
      <header>
        <a className="nav-link" href="/">← Back to app</a>
        <h1>Twilio Voice POC — Docs</h1>
        <p className="sub">Scenarios, events fired, how we handle them, and how to reproduce</p>
      </header>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            className={t.id === active ? 'tab active' : 'tab'}
            onClick={() => {
              window.history.replaceState(null, '', `#${t.id}`)
              setActive(t.id)
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab.intro && <section className="panel doc-intro">{tab.intro}</section>}
      {tab.cards.map((c) => (
        <section key={c.title} className="panel doc-card">
          <h2>{c.title}</h2>
          <dl>
            <dt>What happens / events</dt>
            <dd>{c.events}</dd>
            <dt>How we handle it</dt>
            <dd>{c.handling}</dd>
            <dt>How to reproduce</dt>
            <dd>{c.repro}</dd>
          </dl>
        </section>
      ))}
    </div>
  )
}
