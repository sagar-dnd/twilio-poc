const { Router } = require("express");
const { twilio } = require("../lib/twilioClient");
const { sanitizeIdentity } = require("../lib/identity");
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_PREFLIGHT_TWIML_APP_SID,
  TOKEN_TTL_SECONDS,
  requireEnv,
} = require("../config");

const router = Router();

/** Access token for Voice JS SDK Device */
router.get("/token", requireEnv, (req, res) => {
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

module.exports = router;
