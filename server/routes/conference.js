const { Router } = require("express");
const { twilio, twilioRest } = require("../lib/twilioClient");
const {
  TWILIO_PHONE_NUMBER,
  AGENT_DROP_MESSAGE,
  AGENT_DROP_GRACE_SECONDS,
  AGENT_DROP_HOLD_MUSIC_URL,
  requireEnv,
  baseUrl,
} = require("../config");

const router = Router();

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
  session.cleanupTimer = setTimeout(
    () => agentDropSessions.delete(session.room),
    SESSION_KEEP_MS,
  );
  session.cleanupTimer.unref?.();
}

setInterval(
  () => {
    const now = Date.now();
    for (const [room, s] of agentDropSessions) {
      if (now - s.createdAt > SESSION_MAX_AGE_MS) {
        clearTimeout(s.graceTimer);
        clearTimeout(s.cleanupTimer);
        agentDropSessions.delete(room);
      }
    }
  },
  10 * 60 * 1000,
).unref();

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

function holdTwiml() {
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
  if (session.intentional || session.customerLeft)
    return onAgentLeft(session, callSid);
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
    await updateCustomer(session, holdTwiml(), "hold");
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
router.post("/agent-drop/conference-status", requireEnv, async (req, res) => {
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
router.post("/agent-drop/agent-message", requireEnv, (req, res) => {
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
router.post("/agent-drop/hangup", requireEnv, (req, res) => {
  const session = agentDropSessions.get(sanitizeRoom(req.body?.room));
  if (!session) return res.status(404).json({ error: "unknown room" });
  session.intentional = true;
  dropLog(session, "agent-hangup-requested");
  res.json({ ok: true });
});

router.get("/agent-drop/status", (req, res) => {
  const session = agentDropSessions.get(sanitizeRoom(req.query.room));
  if (!session) return res.status(404).json({ error: "unknown room" });
  const { graceTimer: _t, cleanupTimer: _c, ...rest } = session;
  res.json(rest);
});

router.get("/agent-drop/config", (_req, res) => {
  res.json({
    publicBaseUrlSet: Boolean(baseUrl()),
    message: AGENT_DROP_MESSAGE,
    graceSeconds: Number(AGENT_DROP_GRACE_SECONDS) || 0,
  });
});

module.exports = { router, agentDropVoice };
