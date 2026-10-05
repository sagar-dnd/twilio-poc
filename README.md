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
