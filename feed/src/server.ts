// Entrypoint: bun src/server.ts
//   ARTIFACTS_DIR              artifacts root (default ../artifacts relative to feed/)
//   FEEDBACK_FILE              feedback JSONL log (default ../feedback/events.jsonl relative to feed/)
//   PREFERENCES_FILE           preferences markdown (default ../PREFERENCES.md relative to feed/)
//   PORT                       listen port (default 4242)
//   HOST                       bind address (default 127.0.0.1 — loopback only; the
//                              cloudflared tunnel connects via localhost, so the default
//                              holds for production. Set HOST=0.0.0.0 for direct LAN use.)
//   OPENKEY_ALLOWED_ADDRESSES  comma-separated OpenKey addresses allowed to sign in
//   AUTH_DISABLED              "1" bypasses the OpenKey gate entirely (local HTTP dev)
//   FEED_SESSIONS_DB           override sessions.db path (default feed/sessions.db)
//   DISTILLERY_REPO_ROOT       repo root the Generate button spawns feed-run from
//                              (default ../ relative to feed/). The spawned run
//                              INHERITS this server's env — so to make the button
//                              work you must start the server with TRANSCRIPT_DIRS
//                              + a Gemini key (GOOGLE_AI_API_KEY/GEMINI_API_KEY/
//                              GOOGLE_API_KEY) exported and `claude` on PATH.
//                              ops/launchd/server.sh + server.env do this in prod.

import { resolve } from "node:path";
import { createApp } from "./app.ts";
import { parseAllowedAddresses } from "./auth.ts";

const feedRoot = resolve(import.meta.dir, "..");
const artifactsDir = resolve(feedRoot, process.env.ARTIFACTS_DIR ?? "../artifacts");
const feedbackFile = resolve(
  feedRoot,
  process.env.FEEDBACK_FILE ?? "../feedback/events.jsonl",
);
const preferencesFile = resolve(
  feedRoot,
  process.env.PREFERENCES_FILE ?? "../PREFERENCES.md",
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

// The Generate button (spec §8) spawns ops/launchd/feedrun.sh from the repo
// root. The spawned run inherits this process's env (TRANSCRIPT_DIRS + Gemini
// key + claude on PATH); the wrapper also sources feedrun.env + .env on its own.
const repoRoot = resolve(feedRoot, process.env.DISTILLERY_REPO_ROOT ?? "..");

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
