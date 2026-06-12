// Entrypoint: bun src/server.ts   (this file lives at harness/feed/src/)
//   ARTIFACTS_DIR              artifacts root (default <repoRoot>/artifacts)
//   FEEDBACK_FILE              feedback JSONL log (default <repoRoot>/feedback/events.jsonl)
//   PREFERENCES_FILE           preferences markdown (default <repoRoot>/PREFERENCES.md)
//   PORT                       listen port (default 4242)
//   HOST                       bind address (default 127.0.0.1 — loopback only; the
//                              cloudflared tunnel connects via localhost, so the default
//                              holds for production. Set HOST=0.0.0.0 for direct LAN use.)
//   OPENKEY_ALLOWED_ADDRESSES  comma-separated OpenKey addresses allowed to sign in
//   AUTH_DISABLED              "1" bypasses the OpenKey gate entirely (local HTTP dev)
//   FEED_SESSIONS_DB           override sessions.db path (default harness/feed/sessions.db)
//   DISTILLERY_REPO_ROOT       repo root the Generate button spawns feed-run from
//                              (default the repo root computed from this file's
//                              location: harness/feed/src/ → ../../..). The spawned
//                              run INHERITS this server's env — so to make the button
//                              work you must start the server with TRANSCRIPT_DIRS
//                              + a Gemini key (GOOGLE_AI_API_KEY/GEMINI_API_KEY/
//                              GOOGLE_API_KEY) exported and `claude` on PATH.
//                              harness/ops/launchd/server.sh + server.env do this in prod.

import { resolve } from "node:path";
import { createApp } from "./app.ts";
import { parseAllowedAddresses } from "./auth.ts";

// Re-anchor ALL runtime state to the REPO ROOT, not the feed app dir. This file
// lives at harness/feed/src/server.ts, so the repo root is three levels up. The
// state dirs (artifacts/, feedback/, index/) and PREFERENCES.md stay at the repo
// root regardless of where the feed app is nested (now under harness/feed/), so
// they resolve against repoRoot — never the feed dir. (Before the reorg the
// defaults were "../artifacts" relative to feed/; after feed → harness/feed/
// that would wrongly resolve to harness/artifacts.)
const feedRoot = resolve(import.meta.dir, "..");
const defaultRepoRoot = resolve(import.meta.dir, "..", "..", "..");
const repoRoot = process.env.DISTILLERY_REPO_ROOT
  ? resolve(process.env.DISTILLERY_REPO_ROOT)
  : defaultRepoRoot;
const artifactsDir = resolve(repoRoot, process.env.ARTIFACTS_DIR ?? "artifacts");
const feedbackFile = resolve(
  repoRoot,
  process.env.FEEDBACK_FILE ?? "feedback/events.jsonl",
);
const preferencesFile = resolve(
  repoRoot,
  process.env.PREFERENCES_FILE ?? "PREFERENCES.md",
);
const distDir = resolve(feedRoot, "web/dist");
const port = parseInt(process.env.PORT ?? "4242", 10);

const authDisabled = process.env.AUTH_DISABLED === "1";
const allowedAddresses = parseAllowedAddresses(
  process.env.OPENKEY_ALLOWED_ADDRESSES ?? "",
);
const sessionsDbPath = process.env.FEED_SESSIONS_DB
  ? resolve(feedRoot, process.env.FEED_SESSIONS_DB)
  : undefined; // auth.ts defaults to harness/feed/sessions.db

const app = createApp({
  artifactsDir,
  distDir,
  feedbackFile,
  preferencesFile,
  auth: { disabled: authDisabled, allowedAddresses, sessionsDbPath },
  generate: { repoRoot },
});

// Loopback by default: the cloudflared tunnel connects via localhost. Set
// HOST=0.0.0.0 for direct LAN use — the OpenKey gate covers /api/* and
// /media/*, but only when AUTH_DISABLED is not set.
const hostname = process.env.HOST ?? "127.0.0.1";
const server = Bun.serve({ port, hostname, fetch: app.fetch });

console.log(`distillery feed  http://${server.hostname}:${server.port}`);
console.log(`artifacts        ${artifactsDir}`);
console.log(`feedback         ${feedbackFile}`);
console.log(`preferences      ${preferencesFile}`);
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
