const { twilioRest } = require("./twilioClient");

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

module.exports = { pushToClient };
