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
  TWILIO_PREFLIGHT_TWIML_APP_SID,
  DEFAULT_INBOUND_IDENTITY = "agent-poc",
  PORT = 3001,
  TOKEN_TTL_SECONDS = 3600,
  PUBLIC_BASE_URL = "",
  ENABLE_AMD = "true",
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

  // ?ttl=90 lets the client demo tokenWillExpire / expiry quickly (min 60s).
  const ttl = Math.min(
    Math.max(Number(req.query.ttl || TOKEN_TTL_SECONDS) || 3600, 60),
    86400,
  );
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
      // ?purpose=preflight → optional dedicated echo/Record TwiML app for PreflightTest
      outgoingApplicationSid:
        (req.query.purpose === "preflight" && TWILIO_PREFLIGHT_TWIML_APP_SID) ||
        TWILIO_TWIML_APP_SID,
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
    const parent = req.body.CallSid;
    const base = PUBLIC_BASE_URL.replace(/\/$/, "");
    const dial = twiml.dial({
      callerId: TWILIO_PHONE_NUMBER,
      // answerOnBridge: browser leg stays "ringing" (with early media) until PSTN answers.
      answerOnBridge: true,
      ...(base && { action: `${base}/voice/dial-status?parent=${parent}` }),
    });
    if (base) {
      // Status + AMD callbacks are pushed to the browser as user-defined messages.
      dial.number(
        {
          statusCallback: `${base}/voice/number-status?parent=${parent}`,
          statusCallbackEvent: "initiated ringing answered completed",
          ...(ENABLE_AMD === "true" && {
            machineDetection: "Enable",
            amdStatusCallback: `${base}/voice/amd?parent=${parent}`,
            amdStatusCallbackMethod: "POST",
          }),
        },
        to,
      );
    } else {
      dial.number(to);
    }
  } else if (!to) {
    // No To = PreflightTest call (Device.runPreflight sends no params) → record/playback flow.
    twiml.redirect({ method: "POST" }, "/preflight/record");
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

/**
 * PreflightTest audio check — server replacements for Twilio's "Record" and "Playback"
 * TwiML Bins (twilio.com/docs/voice/sdks/javascript/twiliopreflighttest).
 * Point TWILIO_PREFLIGHT_TWIML_APP_SID's Voice Request URL at POST {PUBLIC_BASE_URL}/preflight/record.
 */
app.post("/preflight/record", requireEnv, (_req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Record a message in 3, 2, 1");
  twiml.record({
    maxLength: 5,
    timeout: 3,
    playBeep: true,
    action: "/preflight/playback",
    method: "POST",
  });
  // Only reached if <Record> captured nothing (no action request).
  twiml.say("Did not detect a message to record");
  twiml.redirect({ method: "POST" }, "/preflight/playback");
  res.type("text/xml").send(twiml.toString());
});

app.post("/preflight/playback", requireEnv, (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const url = req.body.RecordingUrl;
  if (url) {
    twiml.say("You said:");
    twiml.play(url);
  } else {
    twiml.say("No recording was captured.");
  }
  twiml.say("Now waiting for a few seconds to gather audio performance metrics.");
  twiml.pause({ length: 10 });
  twiml.say("Hanging up now.");
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

/** Push a JSON user-defined message to the browser call leg (Call.on('messageReceived')). */
async function pushToClient(parentCallSid, content) {
  if (!parentCallSid) return;
  try {
    await twilioRest()
      .calls(parentCallSid)
      .userDefinedMessages.create({ content: JSON.stringify(content) });
  } catch (e) {
    console.warn("[udm] push failed", parentCallSid, e.message);
  }
}

/** Async AMD result for the PSTN leg → { type: 'amd', answeredBy } */
app.post("/voice/amd", requireEnv, async (req, res) => {
  await pushToClient(req.query.parent, {
    type: "amd",
    answeredBy: req.body.AnsweredBy,
    machineDetectionDuration: req.body.MachineDetectionDuration,
  });
  res.sendStatus(204);
});

/** PSTN leg status (ringing/answered/completed) → { type: 'carrier', status } */
app.post("/voice/number-status", requireEnv, async (req, res) => {
  await pushToClient(req.query.parent, {
    type: "carrier",
    status: req.body.CallStatus,
    sipResponseCode: req.body.SipResponseCode,
  });
  res.sendStatus(204);
});

/** <Dial action> — final outcome (busy/no-answer/failed/completed) */
app.post("/voice/dial-status", requireEnv, async (req, res) => {
  await pushToClient(req.query.parent, {
    type: "dial-result",
    status: req.body.DialCallStatus,
    durationSec: req.body.DialCallDuration,
  });
  res.type("text/xml").send(new twilio.twiml.VoiceResponse().toString());
});

/** Demo: push an arbitrary message, e.g. { type: 'transfer', status: 'ringing' } */
app.post("/demo/push-message", requireEnv, async (req, res) => {
  const { callSid, content } = req.body || {};
  if (!callSid || !content) return res.status(400).json({ error: "callSid + content required" });
  await pushToClient(callSid, content);
  res.json({ ok: true });
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
