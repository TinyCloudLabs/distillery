#!/usr/bin/env bun
// summarize-events.ts — deterministic aggregation of the feedback log.
//
// Usage:
//   bun skills/distill-preferences/scripts/summarize-events.ts \
//     [--events feedback/events.jsonl] [--artifacts-dir artifacts] [--format json|md]
//
// Reads the JSONL event log, scans the artifacts dir to join events with
// each artifact's tags/headline, and prints aggregates (per artifact, per
// tag, per type, plus every note). Judgment about what the aggregates mean
// belongs to the agent (see ../SKILL.md), not this script.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readEvents,
  summarizeEvents,
  FEEDBACK_ACTIONS,
  type ActionCounts,
  type FeedbackArtifactRef,
  type FeedbackSummary,
} from "../../_shared/lib/feedback.ts";

function usage(): never {
  console.error(
    "usage: bun skills/distill-preferences/scripts/summarize-events.ts " +
      "[--events <path>] [--artifacts-dir <path>] [--format json|md]",
  );
  process.exit(2);
}

let eventsPath = "feedback/events.jsonl";
let artifactsDir = "artifacts";
let format = "json";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--events") {
    eventsPath = args[++i] ?? usage();
  } else if (arg === "--artifacts-dir") {
    artifactsDir = args[++i] ?? usage();
  } else if (arg === "--format") {
    format = args[++i] ?? usage();
  } else {
    usage();
  }
}
if (format !== "json" && format !== "md") usage();

/** artifacts/<type>/<slug>/artifact.json → refs for the tag/headline join. */
async function scanArtifactRefs(dir: string): Promise<FeedbackArtifactRef[]> {
  const refs: FeedbackArtifactRef[] = [];
  const listDirs = async (path: string): Promise<string[]> => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const type of await listDirs(dir)) {
    for (const slug of await listDirs(join(dir, type))) {
      try {
        const raw = JSON.parse(
          await readFile(join(dir, type, slug, "artifact.json"), "utf8"),
        ) as Record<string, unknown>;
        if (typeof raw.id !== "string") continue;
        refs.push({
          id: raw.id,
          type: typeof raw.type === "string" ? raw.type : type,
          tags: Array.isArray(raw.tags)
            ? raw.tags.filter((t): t is string => typeof t === "string")
            : [],
          headline: typeof raw.headline === "string" ? raw.headline : undefined,
        });
      } catch {
        // malformed artifact — skip, never fatal
      }
    }
  }
  return refs;
}

function countsCells(c: ActionCounts): string {
  return FEEDBACK_ACTIONS.map((a) => String(c[a])).join(" | ");
}

function renderMd(summary: FeedbackSummary): string {
  const head = FEEDBACK_ACTIONS.join(" | ");
  const sep = FEEDBACK_ACTIONS.map(() => "---").join(" | ");
  const lines: string[] = [];
  lines.push(`# Feedback summary`);
  lines.push("");
  lines.push(`Total events: ${summary.total_events}`);
  lines.push("");
  lines.push(`## By action`);
  lines.push("");
  lines.push(`| ${head} |`);
  lines.push(`| ${sep} |`);
  lines.push(`| ${countsCells(summary.by_action)} |`);
  lines.push("");
  lines.push(`## By artifact`);
  lines.push("");
  if (summary.by_artifact.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(`| artifact | type | tags | ${head} |`);
    lines.push(`| --- | --- | --- | ${sep} |`);
    for (const row of summary.by_artifact) {
      const label = row.headline ?? row.artifact_id;
      lines.push(
        `| ${label} | ${row.artifact_type} | ${(row.tags ?? []).join(", ")} | ${countsCells(row.actions)} |`,
      );
    }
  }
  for (const [title, rows] of [
    ["By tag", summary.by_tag],
    ["By type", summary.by_type],
  ] as const) {
    lines.push("");
    lines.push(`## ${title}`);
    lines.push("");
    if (rows.length === 0) {
      lines.push("(none)");
      continue;
    }
    lines.push(`| key | artifacts | ${head} |`);
    lines.push(`| --- | --- | ${sep} |`);
    for (const row of rows) {
      lines.push(`| ${row.key} | ${row.artifacts} | ${countsCells(row.actions)} |`);
    }
  }
  lines.push("");
  lines.push(`## Notes`);
  lines.push("");
  const notes = summary.by_artifact.flatMap((row) =>
    row.notes.map((n) => ({ ...n, label: row.headline ?? row.artifact_id })),
  );
  if (notes.length === 0) {
    lines.push("(none)");
  } else {
    for (const n of notes) {
      lines.push(`- **${n.action}** on "${n.label}" (${n.ts}): ${n.note}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

const events = await readEvents(eventsPath);
const refs = await scanArtifactRefs(artifactsDir);
const summary = summarizeEvents(events, refs);

if (format === "json") {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(renderMd(summary));
}
