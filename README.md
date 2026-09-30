# SD-7331 — Twilio Voice Client SDK POC

Working prototype: Express issues Access Tokens + TwiML; React uses `@twilio/voice-sdk` `Device`.

## Setup

1. Copy `.env.example` → `.env` and fill in Twilio credentials (API Key/Secret, not Account Auth Token for tokens).
2. In Twilio Console create a **TwiML App** whose Voice URL is your public `POST /voice` (use [ngrok](https://ngrok.com) locally: `ngrok http 3001`).
3. Point a Twilio number (or use the number as `TWILIO_PHONE_NUMBER` caller ID) as needed for PSTN dials.
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
| Outbound / inbound, call events | Connect · second browser w/ other identity → ToClient |
| Mic permission, input/output devices | Audio section after register |
| Token expiry + refresh | `tokenWillExpire` → `updateToken`; short `TOKEN_TTL_SECONDS` |
| Error / disconnect demo | Hang up · Inject invalid token · Unregister then Register |

## Twilio Console checklist

- API Key + Secret (for Access Tokens)
- TwiML App SID → Voice Request URL: `https://<public>/voice`
- Phone number for `callerId` on Dial

## SalesDialer notes

See [FINDINGS.md](./FINDINGS.md) for how this maps to Power / Dynamic / Predictive flows.
