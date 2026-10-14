/** Twilio client identities: strip "client:" and anything outside [A-Za-z0-9_-]. */
function sanitizeIdentity(raw) {
  return String(raw || "")
    .replace(/^client:/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 64);
}

module.exports = { sanitizeIdentity };
