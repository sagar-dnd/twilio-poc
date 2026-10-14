const { Router } = require("express");
const { twilio } = require("../lib/twilioClient");
const { requireEnv } = require("../config");

const router = Router();

/**
 * PreflightTest audio check — server replacements for Twilio's "Record" and "Playback"
 * TwiML Bins (twilio.com/docs/voice/sdks/javascript/twiliopreflighttest).
 * Point TWILIO_PREFLIGHT_TWIML_APP_SID's Voice Request URL at POST {PUBLIC_BASE_URL}/preflight/record.
 */
router.post("/preflight/record", requireEnv, (_req, res) => {
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

router.post("/preflight/playback", requireEnv, (req, res) => {
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

module.exports = router;
