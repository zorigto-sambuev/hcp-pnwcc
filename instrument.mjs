// Import with `import * as Sentry from "@sentry/node"` if you are using ESM
const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://aac169ab15deac7d1f1f9e4e67a0b5f4@o4509956032692224.ingest.us.sentry.io/4509956032954368",
  // Setting this option to true will send default PII data to Sentry.
  // For example, automatic IP address collection on events
  sendDefaultPii: true,
});