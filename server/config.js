const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DEFAULT_AGENT_DROP_MESSAGE =
  "Sorry, we are unable to continue this call right now. We will call you back.";
const DEFAULT_HOLD_MUSIC_URL =
  "http://com.twilio.sounds.music.s3.amazonaws.com/MARKOVICHAMP-Borghestral.mp3";

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

module.exports = { ...config, missing, requireEnv, baseUrl };
