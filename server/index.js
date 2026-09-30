require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const express = require('express');
const cors = require('cors');
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,
  PORT = 3001,
  TOKEN_TTL_SECONDS = 3600,
} = process.env;

const required = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_PHONE_NUMBER',
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`[warn] Missing env: ${missing.join(', ')} — copy .env.example to .env`);
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function requireEnv(_req, res, next) {
  if (missing.length) {
    return res.status(500).json({ error: `Missing env: ${missing.join(', ')}` });
  }
  next();
}

/** Access token for Voice JS SDK Device */
app.get('/token', requireEnv, (req, res) => {
  const identity = String(req.query.identity || 'agent-poc').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  if (!identity) {
    return res.status(400).json({ error: 'identity required' });
  }

  const ttl = Math.min(Math.max(Number(TOKEN_TTL_SECONDS) || 3600, 60), 86400);
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, {
    identity,
    ttl,
  });

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: true,
    })
  );

  res.json({
    identity,
    token: token.toJwt(),
    ttl,
    expiresAt: Date.now() + ttl * 1000,
  });
});

/**
 * TwiML App Voice URL — Twilio hits this when Device.connect() places a call.
 * Params: To (E.164) or ToClient (another Voice identity).
 */
app.post('/voice', requireEnv, (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const to = String(req.body.To || '').trim();
  const toClient = String(req.body.ToClient || '').trim();

  if (toClient) {
    const safe = toClient.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!safe) {
      twiml.say('Invalid client identity.');
    } else {
      const dial = twiml.dial({ callerId: TWILIO_PHONE_NUMBER });
      dial.client(safe);
    }
  } else if (to && /^\+[1-9]\d{6,14}$/.test(to)) {
    const dial = twiml.dial({ callerId: TWILIO_PHONE_NUMBER });
    dial.number(to);
  } else {
    twiml.say('Missing or invalid destination. Pass To as E.164 or ToClient as identity.');
  }

  res.type('text/xml').send(twiml.toString());
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, missingEnv: missing });
});

app.listen(PORT, () => {
  console.log(`Twilio POC API on http://localhost:${PORT}`);
  if (missing.length) console.warn(`Set env before calling: ${missing.join(', ')}`);
});
