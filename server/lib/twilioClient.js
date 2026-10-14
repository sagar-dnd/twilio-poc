const twilio = require("twilio");
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
} = require("../config");

/** REST client authenticated with the API key (same credentials as Access Tokens). */
function twilioRest() {
  return twilio(TWILIO_API_KEY, TWILIO_API_SECRET, {
    accountSid: TWILIO_ACCOUNT_SID,
  });
}

module.exports = { twilio, twilioRest };
