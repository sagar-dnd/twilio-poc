# SD-7331 findings — Twilio Voice JS SDK vs SalesDialer flows

Prototype lives in this repo. Use it to ground the revamp discussion; do not copy legacy dialer patterns until the SDK lifecycle below is clear.

## SDK lifecycle (why each step)

1. **Access Token (server)** — JWT with `identity` + `VoiceGrant` (`outgoingApplicationSid`, `incomingAllow`). Signed with API Key/Secret. Never ship Account Auth Token to the browser.
2. **`new Device(token)`** — Softphone object; no signaling until `register()` or `connect()`.
3. **`register()`** — Opens signaling WebSocket; required for inbound. Outbound can also open the channel via `connect()`.
4. **`tokenWillExpire` → `updateToken()`** — Keep registration and Insights alive; refresh before expiry (POC uses `tokenRefreshMs: 30000`).
5. **`destroy()` / `unregister()`** — Drop signaling and release mic/resources on logout or dialer teardown.

## Call model

- Browser does **not** dial PSTN directly. `device.connect({ params })` connects to Twilio; Twilio requests TwiML from the TwiML App Voice URL (`POST /voice`) and executes `<Dial>`.
- Inbound: Twilio dials `client:<identity>`; Device emits `incoming`; `accept()` / `reject()`.

## Audio

- Request mic via `getUserMedia` before register (permission + device enumeration).
- `device.audio.setInputDevice` / `speakerDevices.set` for headset selection — critical for agents.

## Failure & recovery

| Failure | SDK signal | Recovery |
|---------|------------|----------|
| Token expiry | `tokenWillExpire`, then errors | `updateToken` from `/token` |
| Call drop | `disconnect`, `error`, warnings | UI idle; optional auto-redial policy (product) |
| Network blip | device `error` / re-register | SDK re-registers after signaling recovers; app should re-fetch token if invalid |
| Mic denied | `getUserMedia` reject | Block register; surface permission UX |

## Mapping to SalesDialer modes (discussion starters)

| Mode | Likely Device usage | Open questions (backend / Voice) |
|------|---------------------|----------------------------------|
| **Power** | One Device per agent; `connect` per lead; hangup → next | Who owns dial pacing — FE or BE? Same TwiML App for all modes? |
| **Dynamic** | Same Device; call params may carry campaign/session ids for TwiML | Which params must travel on `connect` for AMD / disposition? |
| **Predictive** | Agent Device mostly **receives** bridged calls (`incoming`); less cold `connect` | How is client identity bound to agent session? Push vs always-registered Device? Conference vs Dial.Client? |

## Patterns to keep vs rethink

- **Keep:** Server-minted short-lived tokens; identity = agent; explicit hangup/cleanup on navigation.
- **Rethink:** Any 8-year-old Client SDK v1 APIs (`Twilio.Device.setup`); long-lived tokens; registering once forever without refresh; hiding audio device selection.

## Demo checklist for the team

- [ ] Register → place E.164 call → see call events → hangup → destroy
- [ ] Two browsers, different identities → ToClient inbound accept/reject
- [ ] Short TTL → watch token refresh in log
- [ ] Inject invalid token → error → Register recovers
