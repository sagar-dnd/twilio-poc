const { Router } = require("express");
const { twilioRest } = require("../lib/twilioClient");
const { sanitizeIdentity } = require("../lib/identity");
const { pushToClient } = require("../lib/pushToClient");
const {
  TWILIO_PHONE_NUMBER,
  DEFAULT_INBOUND_IDENTITY,
  requireEnv,
} = require("../config");

const router = Router();

/**
 * REST: ring a registered browser client (no second browser / no phone needed).
 * Requires Device.register() with the same identity first.
 */
router.post("/demo/ring-client", requireEnv, async (req, res) => {
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

/** Demo: push an arbitrary message, e.g. { type: 'transfer', status: 'ringing' } */
router.post("/demo/push-message", requireEnv, async (req, res) => {
  const { callSid, content } = req.body || {};
  if (!callSid || !content)
    return res.status(400).json({ error: "callSid + content required" });
  await pushToClient(callSid, content);
  res.json({ ok: true });
});

module.exports = router;
