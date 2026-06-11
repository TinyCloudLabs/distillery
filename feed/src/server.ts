// Entrypoint: bun src/server.ts
//   ARTIFACTS_DIR     artifacts root (default ../artifacts relative to feed/)
//   FEEDBACK_FILE     feedback JSONL log (default ../feedback/events.jsonl relative to feed/)
//   PREFERENCES_FILE  preferences markdown (default ../PREFERENCES.md relative to feed/)
//   PORT              listen port (default 4242)
//   HOST              bind address (default 127.0.0.1 — loopback only; the
//                     cloudflared tunnel connects via localhost, so the default
//                     holds for production. Set HOST=0.0.0.0 for direct LAN use,
//                     accepting that /api/preferences is an unauthenticated
//                     write surface.)

import { resolve } from "node:path";
import { createApp } from "./app.ts";

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

const app = createApp({ artifactsDir, distDir, feedbackFile, preferencesFile });

// Loopback by default: PUT /api/preferences is an unauthenticated write into
// a file downstream agents treat as standing instructions — don't expose it
// to the LAN unless explicitly asked to (HOST env).
const hostname = process.env.HOST ?? "127.0.0.1";
const server = Bun.serve({ port, hostname, fetch: app.fetch });

console.log(`distillery feed  http://${server.hostname}:${server.port}`);
console.log(`artifacts        ${artifactsDir}`);
console.log(`feedback         ${feedbackFile}`);
console.log(`preferences      ${preferencesFile}`);
