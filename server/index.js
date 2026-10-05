require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const express = require("express");
const cors = require("cors");
const twilio = require("twilio");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER,
  DEFAULT_INBOUND_IDENTITY = "agent-poc",
  PORT = 3001,
  TOKEN_TTL_SECONDS = 3600,
} = process.env;

const required = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "TWILIO_TWIML_APP_SID",
  "TWILIO_PHONE_NUMBER",
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(
    `[warn] Missing env: ${missing.join(", ")} — copy .env.example to .env`,
  );
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function requireEnv(_req, res, next) {
  if (missing.length) {
    return res
      .status(500)
      .json({ error: `Missing env: ${missing.join(", ")}` });
  }
  next();
}

function sanitizeIdentity(raw) {
  return String(raw || "")
    .replace(/^client:/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
}

function twilioRest() {
  return twilio(TWILIO_API_KEY, TWILIO_API_SECRET, {
    accountSid: TWILIO_ACCOUNT_SID,
  });
}

/** Access token for Voice JS SDK Device */
app.get("/token", requireEnv, (req, res) => {
  const identity = sanitizeIdentity(req.query.identity || "agent-poc");
  if (!identity) {
    return res.status(400).json({ error: "identity required" });
  }

  const ttl = Math.min(Math.max(Number(TOKEN_TTL_SECONDS) || 3600, 60), 86400);
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    {
      identity,
      ttl,
    },
  );

  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: true,
    }),
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
 * Only E.164 numbers are allowed.
 */
app.post("/voice", requireEnv, (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const to = String(req.body.To || "").trim();

  if (to && /^\+[1-9]\d{6,14}$/.test(to)) {
    const dial = twiml.dial({
      callerId: TWILIO_PHONE_NUMBER,
      answerOnBridge: true,
    });
    dial.number(to);
  } else {
    twiml.say("Invalid destination. Pass To as an E.164 phone number.");
  }
  console.log(twiml.toString());

  res.type("text/xml").send(twiml.toString());
});

/**
 * Phone number Voice webhook — PSTN → browser.
 * Point the Twilio number's Voice URL here (POST), not only the TwiML App.
 * Optional ?identity=agent-poc (defaults to DEFAULT_INBOUND_IDENTITY).
 */
app.all("/voice/inbound", requireEnv, (req, res) => {
  const identity = sanitizeIdentity(
    req.query.identity || req.body.identity || DEFAULT_INBOUND_IDENTITY,
  );
  const twiml = new twilio.twiml.VoiceResponse();
  if (!identity) {
    twiml.say("No inbound client identity configured.");
  } else {
    const dial = twiml.dial({
      callerId: req.body.From || TWILIO_PHONE_NUMBER,
      answerOnBridge: true,
    });
    dial.client(identity);
  }
  res.type("text/xml").send(twiml.toString());
});

/**
 * REST: ring a registered browser client (no second browser / no phone needed).
 * Requires Device.register() with the same identity first.
 */
app.post("/demo/ring-client", requireEnv, async (req, res) => {
  const identity = sanitizeIdentity(
    req.body.identity || req.query.identity || DEFAULT_INBOUND_IDENTITY,
  );
  if (!identity) {
    return res.status(400).json({ error: "identity required" });
  }

  try {
    const call = await twilioRest().calls.create({
      to: `client:${identity}`,
      from: TWILIO_PHONE_NUMBER,
      twiml:
        '<Response><Say voice="alice">Inbound demo call. You are connected.</Say><Pause length="30"/></Response>',
    });
    res.json({ ok: true, callSid: call.sid, to: `client:${identity}` });
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    missingEnv: missing,
    defaultInboundIdentity: DEFAULT_INBOUND_IDENTITY,
    inboundVoicePath: "/voice/inbound",
  });
});

app.listen(PORT, () => {
  console.log(`Twilio POC API on http://localhost:${PORT}`);
  console.log(
    `Inbound phone webhook: POST /voice/inbound (point Twilio number Voice URL here)`,
  );
  console.log(`Demo ring: POST /demo/ring-client  { "identity": "agent-poc" }`);
  if (missing.length)
    console.warn(`Set env before calling: ${missing.join(", ")}`);
});
