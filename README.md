# SD-7331 — Twilio Voice Client SDK POC

Working prototype: Express issues Access Tokens + TwiML; React uses `@twilio/voice-sdk` `Device`.

## Setup

1. Copy `.env.example` → `.env` and fill in Twilio credentials (API Key/Secret, not Account Auth Token for tokens).
2. In Twilio Console create a **TwiML App** whose Voice URL is your public `POST /voice` (use [ngrok](https://ngrok.com) locally: `ngrok http 3001`).
3. For **phone → browser** inbound: set the Twilio number’s Voice URL to `https://<public>/voice/inbound?identity=agent-poc` (POST). The TwiML App URL alone does **not** handle PSTN inbound.
4. Use that number as `TWILIO_PHONE_NUMBER` (caller ID / REST From).
4. Install & run:

```bash
cp .env.example .env   # then edit
cd server && npm install && npm run dev
# other terminal
cd client && npm install && npm run dev
```

Open http://localhost:5173

## What this covers (ticket AC)

| Area | Where |
|------|--------|
| SDK setup, tokens, register, cleanup | Register / Unregister in UI · `useTwilioDevice.js` |
| Outbound / inbound, call events | Connect · **Ring this identity** · second browser ToClient · phone → `/voice/inbound` |
| Mic permission, input/output devices | Audio section after register |
| Token expiry + refresh | `tokenWillExpire` → `updateToken`; short `TOKEN_TTL_SECONDS` |
| Error / disconnect demo | Hang up · Inject invalid token · Unregister then Register |

## Twilio Console checklist

- API Key + Secret (for Access Tokens)
- TwiML App SID → Voice Request URL: `https://<public>/voice`
- Phone number for `callerId` on Dial

## SalesDialer notes

See [FINDINGS.md](./FINDINGS.md) for how this maps to Power / Dynamic / Predictive flows.

## Event handling scenarios (Voice JS SDK v2)

Device options (`client/src/useTwilioDevice.js`): `tokenRefreshMs: 30000`, `maxCallSignalingTimeoutMs: 30000`,
`enableImprovedSignalingErrorPrecision: true`, `allowIncomingWhileBusy: true` (incoming calls always ring,
even mid-call), `closeProtection`. Error catalog + disposition mapping live in `client/src/twilioEvents.js`.

**Device events handled:** `registering`, `registered`, `unregistered`, `error`, `incoming`, `tokenWillExpire`, `destroyed`
(+ `device.audio` `deviceChange`).
**Call events handled:** `accept`, `ringing(hasEarlyMedia)`, `disconnect`, `cancel`, `reject`, `error`, `mute`,
`reconnecting`, `reconnected`, `sample`, `volume`, `warning`, `warning-cleared`, `messageReceived`, `messageSent`, `audio`.

The Event log panel can be filtered by source (device / call / audio / network / app). Panel **2b** shows live health.

| Scenario | Event(s) | Handling | Reproduce manually |
|---|---|---|---|
| Token expiry / laptop sleep | `tokenWillExpire`, `error` 20101/20104/31204/31205, `visibilitychange`/`online` | Refetch `/token` → `device.updateToken()`; on wake, refresh if near expiry and re-register if not registered | Set TTL override to 90s, Register, wait ~60s (refresh fires 30s before expiry). Or "Inject invalid token" then Connect. Or close lid >TTL and reopen |
| Wi-Fi drop / network switch mid-call | `call.reconnecting` / `reconnected`, `disconnect` after 30s | "Reconnecting…" badge; call kept up to `maxCallSignalingTimeoutMs` (30s) | Mid-call, toggle Wi-Fi off for 5–10s then on (or switch Wi-Fi → hotspot) |
| Firewall / WebSocket blocked | `device.error` 31005/31009/53000/53001, `unregistered` | Re-register with exponential backoff + jitter (1s → 30s cap) | Block `chunderw-vpc-gll.twilio.com` / `*.twilio.com:443` (e.g. Little Snitch, `/etc/hosts`) and Register |
| Mic denied | getUserMedia `NotAllowedError`, `error` 31401 | Pre-flight `getUserMedia` before Device; banner with permission help | Site settings → Microphone → Block, then Register |
| Mic busy / unplugged | `error` 31402, `audio.deviceChange(lostActiveDevices)` | Fall back to `default` mic, refresh picker | Unplug USB/BT headset mid-call, or select a mic another app holds exclusively |
| Mic dead (no audio) | `call.volume` | Input level ~0 for 5s while unmuted → "Mic silent" badge (clears on recovery) | Mid-call, set OS input volume to 0 (or pick a muted hardware mic) |
| Customer hangup | `disconnect` after `accept` | Disposition "Connected (customer hangup)" | Answer on the phone, hang up from phone |
| Agent hangup | `disconnect` after `hangup()` | Disposition "Connected (agent hangup)" | Answer, click Hang up |
| No answer timeout | client timer → `disconnect`; `<Dial action>` `no-answer` | Agent-side ring cap (2b input, default 30s) → "No answer" | Dial a phone and let it ring |
| Busy / declined / unavailable | `error` 31486 / 31603 / 31480 (improved precision) | Mapped to Busy / Declined / Unavailable dispositions | Reject on the phone (declined), call a line already on a call (busy), phone off / airplane mode (unavailable) |
| Inbound callback while busy | `device.incoming` while a call is active | Always rings (no auto-reject). Agent can Accept (ends current call), Reject, or Ignore; a caller hang-up goes to Missed | During an outbound call, click "Ring this browser" or call the Twilio number |
| Inbound cancel (missed) | `call.cancel` | Remove incoming banner, add to Missed list, disposition "Missed" | Ring the browser and hang up from caller before accepting |
| Inbound ignore | `call.ignore()` | Stops local ringing; caller later cancels → Missed | Click Ignore on the incoming banner |
| Early media (carrier messages) | `ringing(hasEarlyMedia=true)` | "Early media" badge; audio plays via `answerOnBridge` | Dial an invalid/disconnected number that plays a carrier announcement |
| Voicemail / AMD | `messageReceived` `{type:'amd'}` from `/voice/amd` | Shows AMD result; machine → "Voicemail" disposition | Set `PUBLIC_BASE_URL` (ngrok), dial a phone and let voicemail answer |
| Carrier leg status / final result | `messageReceived` `{type:'carrier'|'dial-result'}` | Shows carrier leg status; dial result feeds disposition | Same as AMD (needs `PUBLIC_BASE_URL`) |
| Transfer status | `messageReceived` `{type:'transfer'}` | Shows transfer status | Mid-call, click "Push transfer: ringing/completed" (server `/demo/push-message`) |
| Call quality | `sample`, `warning` / `warning-cleared` (high-rtt, high-jitter, high-packet-loss, low-mos, constant-audio-input-level…) | MOS/RTT/jitter/loss row + warning badges; sampled into log every 10s | Use macOS Network Link Conditioner ("Very Bad Network") mid-call |
| Send app message | `messageSent` | Logged with `voiceEventSid` | Mid-call, click "Send message" |

Error codes checked against `twilio.com/docs/api/errors/<code>` and the 2.0 changelog (31201→31402, 31208→31401,
31003→53405, 31901→53000). In SDK v2, mic denied is **31401**; **31208** is the v1 code.

`messageReceived` scenarios need Twilio to reach the server: run `ngrok http 3001` and set `PUBLIC_BASE_URL` in `.env`.

## Network test (PreflightTest)

Panel **0** runs `Device.runPreflight(token, options)` (`client/src/usePreflight.js`). It handles the `connected`,
`sample`, `warning`, `completed` and `failed` events, and shows: call quality rating (`excellent` / `great` / `good` /
`fair` / `degraded`), average MOS / RTT / jitter, packet loss, the selected ICE candidate (type / protocol / network
type), whether TURN was required, edge, signaling time, warnings and errors. **Stop** raises `failed` with 31008.

**When to run it:** pre-shift, before the agent goes Available; after a network issue (reconnecting or dropped calls,
quality warnings); after changing Wi-Fi, VPN or location. Don't run it during a live call (the button is disabled then).

**Requirements:**
- The token is fetched with `/token?purpose=preflight&identity=<id>-preflight`. It uses `TWILIO_PREFLIGHT_TWIML_APP_SID`
  if that's set, otherwise `TWILIO_TWIML_APP_SID`.
- With the default app, `/voice` sees no `To` and treats the call as a test: it plays a prompt, pauses 18s so samples
  are collected, then hangs up. **No extra setup is needed** for metrics.
- Twilio's recommended setup (audio record/playback check): create the "Record" and "Playback" TwiML Bins and a TwiML app
  pointing at Record, as described in
  [Twilio.PreflightTest](https://www.twilio.com/docs/voice/sdks/javascript/twiliopreflighttest), then set
  `TWILIO_PREFLIGHT_TWIML_APP_SID`. To use `fakeMicInput: true` (no real mic), that app **must** echo audio back.
- Each test is a real Twilio call (~20s of usage) and shows up in the Call logs.
