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
  AGENT_DROP_MESSAGE = "Sorry, we are unable to continue this call right now. We will call you back.",
  AGENT_DROP_GRACE_SECONDS = "0",
  AGENT_DROP_HOLD_MUSIC_URL = "http://com.twilio.sounds.music.s3.amazonaws.com/MARKOVICHAMP-Borghestral.mp3",
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

  // Agent-drop demo: browser leg joins a conference instead of <Dial><Number>.
  if (req.body.mode === "conference") {
    return res.type("text/xml").send(agentDropVoice(req.body));
  }

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
  twiml.say(
    "Now waiting for a few seconds to gather audio performance metrics.",
  );
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
  if (!callSid || !content)
    return res.status(400).json({ error: "callSid + content required" });
  await pushToClient(callSid, content);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Agent drop (Wi-Fi) demo — keep the customer when the agent's leg dies.
 * Agent (browser) and customer are separate legs in a <Conference>, so the
 * customer leg survives the agent leg. On an unexpected agent
 * participant-leave we redirect the customer leg to hold music (grace) and/or
 * a sorry <Say> + <Hangup>. Sessions live in memory (POC only).
 * ------------------------------------------------------------------ */
const agentDropSessions = new Map(); // room -> session

const SESSION_KEEP_MS = 10 * 60 * 1000; // keep ended sessions 10 min for the status UI
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // hard TTL for abandoned sessions
// Wait briefly before treating an agent leave as unexpected, so a late
// "intentional" signal (HTTP or in-call message) can still arrive.
const UNEXPECTED_DEBOUNCE_MS = 2000;

function endSession(session) {
  session.state = "ended";
  clearTimeout(session.graceTimer);
  session.graceTimer = null;
  clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => agentDropSessions.delete(session.room), SESSION_KEEP_MS);
  session.cleanupTimer.unref?.();
}

setInterval(() => {
  const now = Date.now();
  for (const [room, s] of agentDropSessions) {
    if (now - s.createdAt > SESSION_MAX_AGE_MS) {
      clearTimeout(s.graceTimer);
      clearTimeout(s.cleanupTimer);
      agentDropSessions.delete(room);
    }
  }
}, 10 * 60 * 1000).unref();

function sanitizeRoom(raw) {
  return String(raw || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
}

function dropLog(session, event, detail) {
  const entry = { at: Date.now(), event, detail: detail ?? null };
  session.timeline.push(entry);
  console.log(`[agent-drop ${session.room}] ${event}`, detail ?? "");
}

function baseUrl() {
  return PUBLIC_BASE_URL.replace(/\/$/, "");
}

function conferenceTwiml(room, { agent }) {
  const twiml = new twilio.twiml.VoiceResponse();
  const dial = twiml.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,
      // Agent leaving must NOT end the room; customer leaving ends it.
      endConferenceOnExit: !agent,
      beep: false,
      ...(agent && {
        statusCallback: `${baseUrl()}/agent-drop/conference-status?room=${room}`,
        statusCallbackEvent: "join leave end",
        statusCallbackMethod: "POST",
      }),
    },
    room,
  );
  return twiml.toString();
}

function sorryTwiml(session) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say(session.message);
  twiml.hangup();
  return twiml.toString();
}

function holdTwiml(session) {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Please hold for a moment.");
  twiml.play({ loop: 0 }, AGENT_DROP_HOLD_MUSIC_URL);
  return twiml.toString();
}

/** TwiML for the browser leg (params: To, mode=conference, room, grace, message, rejoin). */
function agentDropVoice(body) {
  const room = sanitizeRoom(body.room);
  const to = String(body.To || "").trim();
  const err = (msg) => {
    const t = new twilio.twiml.VoiceResponse();
    t.say(msg);
    return t.toString();
  };
  if (!baseUrl())
    return err(
      "Agent drop demo needs PUBLIC_BASE_URL for conference callbacks.",
    );
  if (!room) return err("Missing room.");

  let session = agentDropSessions.get(room);
  if (body.rejoin === "1") {
    if (!session) return err("This call has already ended.");
    session.agentCallSid = body.CallSid;
    dropLog(session, "agent-rejoining", body.CallSid);
    return conferenceTwiml(room, { agent: true });
  }
  if (!/^\+[1-9]\d{6,14}$/.test(to))
    return err("Invalid destination. Pass To as an E.164 phone number.");
  const grace = Math.min(
    Math.max(Number(body.grace ?? AGENT_DROP_GRACE_SECONDS) || 0, 0),
    120,
  );
  session = {
    room,
    to,
    agentCallSid: body.CallSid,
    customerCallSid: null,
    grace,
    message:
      String(body.message || "")
        .trim()
        .slice(0, 500) || AGENT_DROP_MESSAGE,
    intentional: false,
    state: "agent-connecting",
    outcome: null,
    graceTimer: null,
    timeline: [],
    createdAt: Date.now(),
    cleanupTimer: null,
  };
  agentDropSessions.set(room, session);
  dropLog(session, "agent-connecting", body.CallSid);
  return conferenceTwiml(room, { agent: true });
}

async function updateCustomer(session, twiml, label) {
  if (!session.customerCallSid) return;
  try {
    await twilioRest().calls(session.customerCallSid).update({ twiml });
  } catch (e) {
    dropLog(session, "customer-update-failed", `${label}: ${e.message}`);
  }
}

async function onAgentLeft(session, callSid) {
  if (session.customerLeft) {
    dropLog(session, "agent-left (customer ended the call)", callSid);
    return;
  }
  if (session.intentional) {
    dropLog(session, "agent-left (hang up)", callSid);
    endSession(session);
    session.outcome = "Agent hung up normally";
    if (session.customerCallSid) {
      await twilioRest()
        .calls(session.customerCallSid)
        .update({ status: "completed" })
        .catch(() => {});
    }
    return;
  }
  // Debounce: give a late intentional signal a chance to land.
  await new Promise((r) => setTimeout(r, UNEXPECTED_DEBOUNCE_MS));
  if (session.intentional || session.customerLeft) return onAgentLeft(session, callSid);
  dropLog(session, "agent-left (unexpected)", callSid);
  if (!session.customerCallSid) {
    endSession(session);
    session.outcome = "Agent dropped before the customer joined";
    return;
  }
  if (session.grace > 0) {
    session.state = "grace";
    dropLog(
      session,
      "customer-on-hold",
      `${session.grace}s grace for agent to rejoin`,
    );
    await updateCustomer(session, holdTwiml(session), "hold");
    session.graceTimer = setTimeout(async () => {
      session.graceTimer = null;
      if (session.state !== "grace") return;
      session.state = "message";
      dropLog(session, "customer-hearing-message", "grace expired");
      await updateCustomer(session, sorryTwiml(session), "sorry");
    }, session.grace * 1000);
  } else {
    session.state = "message";
    dropLog(session, "customer-hearing-message", session.message);
    await updateCustomer(session, sorryTwiml(session), "sorry");
  }
}

/** Conference statusCallback (agent's <Conference> only). */
app.post("/agent-drop/conference-status", requireEnv, async (req, res) => {
  res.sendStatus(204);
  const session = agentDropSessions.get(sanitizeRoom(req.query.room));
  if (!session) return;
  const ev = req.body.StatusCallbackEvent;
  const callSid = req.body.CallSid;
  const isAgent = callSid && callSid === session.agentCallSid;

  if (ev === "participant-join") {
    if (isAgent) {
      if (session.state === "grace") {
        // Agent came back in time: pull the customer back into the room.
        clearTimeout(session.graceTimer);
        session.graceTimer = null;
        session.state = "connected";
        dropLog(session, "agent-rejoined", callSid);
        await updateCustomer(
          session,
          conferenceTwiml(session.room, { agent: false }),
          "rejoin",
        );
        return;
      }
      dropLog(session, "agent-joined", callSid);
      // Second "intentional hang-up" channel: the browser sends an in-call message
      // (call.sendMessage) right before disconnecting; it travels over Twilio
      // signaling, so it works even if our HTTP /agent-drop/hangup can't be reached.
      twilioRest()
        .calls(callSid)
        .userDefinedMessageSubscriptions.create({
          callback: `${baseUrl()}/agent-drop/agent-message?room=${session.room}`,
          method: "POST",
        })
        .catch((e) => dropLog(session, "udm-subscribe-failed", e.message));
      if (!session.customerCallSid && session.state === "agent-connecting") {
        session.state = "dialing-customer";
        try {
          const call = await twilioRest().calls.create({
            to: session.to,
            from: TWILIO_PHONE_NUMBER,
            twiml: conferenceTwiml(session.room, { agent: false }),
          });
          session.customerCallSid = call.sid;
          dropLog(session, "dialing-customer", `${session.to} (${call.sid})`);
        } catch (e) {
          endSession(session);
          session.outcome = `Customer dial failed: ${e.message}`;
          dropLog(session, "customer-dial-failed", e.message);
        }
      }
    } else {
      if (!session.customerCallSid) session.customerCallSid = callSid;
      if (session.state === "dialing-customer") session.state = "connected";
      dropLog(session, "customer-joined", callSid);
    }
  } else if (ev === "participant-leave") {
    if (isAgent) await onAgentLeft(session, callSid);
    else if (session.state !== "grace") {
      if (session.state !== "message") session.customerLeft = true;
      dropLog(session, "customer-left", callSid);
    }
  } else if (ev === "conference-end") {
    if (session.state === "grace") return; // customer temporarily on hold outside the room
    dropLog(
      session,
      "conference-ended",
      req.body.ReasonConferenceEnded || null,
    );
    if (session.state === "message")
      session.outcome = "Customer heard the sorry message, then the call ended";
    else if (!session.outcome)
      session.outcome = session.customerLeft
        ? "Customer hung up"
        : "Call ended";
    endSession(session);
  }
});

/** UserDefinedMessage from the agent's browser leg ({ type: 'agent-hangup' }). */
app.post("/agent-drop/agent-message", requireEnv, (req, res) => {
  res.sendStatus(204);
  const session = agentDropSessions.get(sanitizeRoom(req.query.room));
  if (!session) return;
  let content = {};
  try {
    content = JSON.parse(req.body.Content || "{}");
  } catch {
    return;
  }
  if (content.type === "agent-hangup" && !session.intentional) {
    session.intentional = true;
    dropLog(session, "agent-hangup-message (in-call)");
  }
});

/** Client marks the next agent leave as intentional (call before disconnect). */
app.post("/agent-drop/hangup", requireEnv, (req, res) => {
  const session = agentDropSessions.get(sanitizeRoom(req.body?.room));
  if (!session) return res.status(404).json({ error: "unknown room" });
  session.intentional = true;
  dropLog(session, "agent-hangup-requested");
  res.json({ ok: true });
});

app.get("/agent-drop/status", (req, res) => {
  const session = agentDropSessions.get(sanitizeRoom(req.query.room));
  if (!session) return res.status(404).json({ error: "unknown room" });
  const { graceTimer: _t, cleanupTimer: _c, ...rest } = session;
  res.json(rest);
});

app.get("/agent-drop/config", (_req, res) => {
  res.json({
    publicBaseUrlSet: Boolean(baseUrl()),
    message: AGENT_DROP_MESSAGE,
    graceSeconds: Number(AGENT_DROP_GRACE_SECONDS) || 0,
  });
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
