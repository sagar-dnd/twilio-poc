/**
 * Twilio + environment: dotenv config with validation, the REST client and small helpers
 * shared by the routes in index.js.
 */
const path = require("path");
const twilio = require("twilio");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DEFAULT_AGENT_DROP_MESSAGE =
  "Sorry, we are unable to continue this call right now. We will call you back.";
const DEFAULT_HOLD_MUSIC_URL =
  "http://com.twilio.sounds.music.s3.amazonaws.com/MARKOVICHAMP-Borghestral.mp3";

// ---------------------------------------------------------------------------
// Config / env validation
// ---------------------------------------------------------------------------

const env = process.env;

const config = {
  TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY: env.TWILIO_API_KEY,
  TWILIO_API_SECRET: env.TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID: env.TWILIO_TWIML_APP_SID,
  TWILIO_PHONE_NUMBER: env.TWILIO_PHONE_NUMBER,
  TWILIO_PREFLIGHT_TWIML_APP_SID: env.TWILIO_PREFLIGHT_TWIML_APP_SID,
  DEFAULT_INBOUND_IDENTITY: env.DEFAULT_INBOUND_IDENTITY || "agent-poc",
  PORT: env.PORT || 3001,
  TOKEN_TTL_SECONDS: env.TOKEN_TTL_SECONDS || 3600,
  PUBLIC_BASE_URL: env.PUBLIC_BASE_URL || "",
  ENABLE_AMD: env.ENABLE_AMD || "true",
  AGENT_DROP_MESSAGE: env.AGENT_DROP_MESSAGE || DEFAULT_AGENT_DROP_MESSAGE,
  AGENT_DROP_GRACE_SECONDS: env.AGENT_DROP_GRACE_SECONDS || "0",
  AGENT_DROP_HOLD_MUSIC_URL:
    env.AGENT_DROP_HOLD_MUSIC_URL || DEFAULT_HOLD_MUSIC_URL,
};

const REQUIRED_ENV = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "TWILIO_TWIML_APP_SID",
  "TWILIO_PHONE_NUMBER",
];

const missing = REQUIRED_ENV.filter((k) => !env[k]);

/** Fail requests (not boot) when Twilio credentials are missing, so /health still works. */
function requireEnv(_req, res, next) {
  if (missing.length) {
    return res
      .status(500)
      .json({ error: `Missing env: ${missing.join(", ")}` });
  }
  next();
}

/** Public https base for Twilio callbacks, without a trailing slash ("" when unset). */
function baseUrl() {
  return config.PUBLIC_BASE_URL.replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** REST client authenticated with the API key (same credentials as Access Tokens). */
function twilioRest() {
  return twilio(config.TWILIO_API_KEY, config.TWILIO_API_SECRET, {
    accountSid: config.TWILIO_ACCOUNT_SID,
  });
}

/** Twilio client identities: strip "client:" and anything outside [A-Za-z0-9_-]. */
function sanitizeIdentity(raw) {
  return String(raw || "")
    .replace(/^client:/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
}

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

module.exports = {
  ...config,
  missing,
  requireEnv,
  baseUrl,
  twilio,
  twilioRest,
  sanitizeIdentity,
  pushToClient,
};
