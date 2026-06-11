// Entrypoint: bun src/server.ts
//   ARTIFACTS_DIR              artifacts root (default ../artifacts relative to feed/)
//   FEEDBACK_FILE              feedback JSONL log (default ../feedback/events.jsonl relative to feed/)
//   PORT                       listen port (default 4242)
//   OPENKEY_ALLOWED_ADDRESSES  comma-separated OpenKey addresses allowed to sign in
//   AUTH_DISABLED              "1" bypasses the OpenKey gate entirely (local HTTP dev)
//   FEED_SESSIONS_DB           override sessions.db path (default feed/sessions.db)

import { resolve } from "node:path";
import { createApp } from "./app.ts";
import { parseAllowedAddresses } from "./auth.ts";

const feedRoot = resolve(import.meta.dir, "..");
const artifactsDir = resolve(feedRoot, process.env.ARTIFACTS_DIR ?? "../artifacts");
const feedbackFile = resolve(
  feedRoot,
  process.env.FEEDBACK_FILE ?? "../feedback/events.jsonl",
);
const distDir = resolve(feedRoot, "web/dist");
const port = parseInt(process.env.PORT ?? "4242", 10);

const authDisabled = process.env.AUTH_DISABLED === "1";
const allowedAddresses = parseAllowedAddresses(
  process.env.OPENKEY_ALLOWED_ADDRESSES ?? "",
);
const sessionsDbPath = process.env.FEED_SESSIONS_DB
  ? resolve(feedRoot, process.env.FEED_SESSIONS_DB)
  : undefined; // auth.ts defaults to feed/sessions.db

const app = createApp({
  artifactsDir,
  distDir,
  feedbackFile,
  auth: { disabled: authDisabled, allowedAddresses, sessionsDbPath },
});

Bun.serve({ port, fetch: app.fetch });

console.log(`distillery feed  http://localhost:${port}`);
console.log(`artifacts        ${artifactsDir}`);
console.log(`feedback         ${feedbackFile}`);
if (authDisabled) {
  console.warn(
    [
      "",
      "!!=====================================================================!!",
      "!!  AUTH_DISABLED=1 — OpenKey front-door auth is OFF.                  !!",
      "!!  Every /api and /media route is open to anyone who can reach this   !!",
      "!!  server. Local development only. NEVER deploy like this.            !!",
      "!!=====================================================================!!",
      "",
    ].join("\n"),
  );
} else if (allowedAddresses.length === 0) {
  console.warn(
    "auth: OPENKEY_ALLOWED_ADDRESSES is empty — nobody can sign in. " +
      "Set it (comma-separated addresses) or AUTH_DISABLED=1 for local dev.",
  );
} else {
  console.log(`auth             OpenKey gate ON (${allowedAddresses.length} allowlisted)`);
}
