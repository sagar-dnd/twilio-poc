const { Router } = require("express");
const { twilio } = require("../lib/twilioClient");
const { sanitizeIdentity } = require("../lib/identity");
const { pushToClient } = require("../lib/pushToClient");
const { agentDropVoice } = require("./conference");
const {
  TWILIO_PHONE_NUMBER,
  DEFAULT_INBOUND_IDENTITY,
  ENABLE_AMD,
  requireEnv,
  baseUrl,
} = require("../config");

const router = Router();

/**
 * TwiML App Voice URL — Twilio hits this when Device.connect() places a call.
 * Only E.164 numbers are allowed.
 */
router.post("/voice", requireEnv, (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const to = String(req.body.To || "").trim();

  // Agent-drop demo: browser leg joins a conference instead of <Dial><Number>.
  if (req.body.mode === "conference") {
    return res.type("text/xml").send(agentDropVoice(req.body));
  }

  if (to && /^\+[1-9]\d{6,14}$/.test(to)) {
    const parent = req.body.CallSid;
    const base = baseUrl();
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
router.all("/voice/inbound", requireEnv, (req, res) => {
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

/** Async AMD result for the PSTN leg → { type: 'amd', answeredBy } */
router.post("/voice/amd", requireEnv, async (req, res) => {
  await pushToClient(req.query.parent, {
    type: "amd",
    answeredBy: req.body.AnsweredBy,
    machineDetectionDuration: req.body.MachineDetectionDuration,
  });
  res.sendStatus(204);
});

/** PSTN leg status (ringing/answered/completed) → { type: 'carrier', status } */
router.post("/voice/number-status", requireEnv, async (req, res) => {
  await pushToClient(req.query.parent, {
    type: "carrier",
    status: req.body.CallStatus,
    sipResponseCode: req.body.SipResponseCode,
  });
  res.sendStatus(204);
});

/** <Dial action> — final outcome (busy/no-answer/failed/completed) */
router.post("/voice/dial-status", requireEnv, async (req, res) => {
  await pushToClient(req.query.parent, {
    type: "dial-result",
    status: req.body.DialCallStatus,
    durationSec: req.body.DialCallDuration,
  });
  res.type("text/xml").send(new twilio.twiml.VoiceResponse().toString());
});

module.exports = router;
