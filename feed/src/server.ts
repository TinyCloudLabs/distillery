// Entrypoint: bun src/server.ts
//   ARTIFACTS_DIR  artifacts root (default ../artifacts relative to feed/)
//   FEEDBACK_FILE  feedback JSONL log (default ../feedback/events.jsonl relative to feed/)
//   PORT           listen port (default 4242)

import { resolve } from "node:path";
import { createApp } from "./app.ts";

const feedRoot = resolve(import.meta.dir, "..");
const artifactsDir = resolve(feedRoot, process.env.ARTIFACTS_DIR ?? "../artifacts");
const feedbackFile = resolve(
  feedRoot,
  process.env.FEEDBACK_FILE ?? "../feedback/events.jsonl",
);
const distDir = resolve(feedRoot, "web/dist");
const port = parseInt(process.env.PORT ?? "4242", 10);

const app = createApp({ artifactsDir, distDir, feedbackFile });

Bun.serve({ port, fetch: app.fetch });

console.log(`distillery feed  http://localhost:${port}`);
console.log(`artifacts        ${artifactsDir}`);
console.log(`feedback         ${feedbackFile}`);
