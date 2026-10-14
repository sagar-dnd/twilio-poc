const express = require("express");
const cors = require("cors");
const { PORT, DEFAULT_INBOUND_IDENTITY, missing } = require("./config");
const tokenRoutes = require("./routes/token");
const voiceRoutes = require("./routes/voice");
const preflightRoutes = require("./routes/preflight");
const demoRoutes = require("./routes/demo");
const { router: conferenceRoutes } = require("./routes/conference");

if (missing.length) {
  console.warn(
    `[warn] Missing env: ${missing.join(", ")} — copy .env.example to .env`,
  );
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(tokenRoutes);
app.use(voiceRoutes);
app.use(preflightRoutes);
app.use(demoRoutes);
app.use(conferenceRoutes);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    missingEnv: missing,
    defaultInboundIdentity: DEFAULT_INBOUND_IDENTITY,
    inboundVoicePath: "/voice/inbound",
  });
});

app.listen(PORT, () => {
  console.log(`Twilio POC API on http://localhost:${PORT}`);
  console.log(
    `Inbound phone webhook: POST /voice/inbound (point Twilio number Voice URL here)`,
  );
  console.log(`Demo ring: POST /demo/ring-client  { "identity": "agent-poc" }`);
  if (missing.length)
    console.warn(`Set env before calling: ${missing.join(", ")}`);
});
