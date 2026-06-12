#!/usr/bin/env bun
// run-generation.ts — the HEADLESS generation runner (spec §7/§8).
//
// THE PIECE THAT WAS NEVER WIRED. Until now, every distillery generation was a
// human dispatching an agent by hand against a run-brief. This runner closes the
// loop: given a run-brief (the markdown the feed-run recipe produces under
// index/runs/<ts>/), it invokes a generation AGENT HEADLESSLY via `claude -p`
// (the reference_claude_cli_headless recipe) to consume the brief and produce
// artifacts — no interactive session, no human in the loop.
//
// BOUNDARY (non-negotiable): the index / query / feed-run SCRIPTS remain
// LLM-free (they surface; the agent judges). This runner is the ORCHESTRATION
// layer, explicitly allowed to invoke the agent CLI. It does not reason about
// transcripts itself — it spawns an agent that does, then DETERMINISTICALLY
// learns what was produced by diffing artifacts/ before vs after.
//
// Usage (also importable — `runGeneration` is the programmatic entry point used
// by feed-run.ts):
//   bun harness/feed-run/scripts/run-generation.ts \
//     --brief index/runs/<ts>/run-brief.md \
//     [--artifacts-dir artifacts] [--cap 3] [--model opus] \
//     [--repo-root .] [--run-id <iso>] [--log index/runs/<ts>/generation-log.txt]
//
// Model: default `opus` (Hunter's best-model default); overridable via
// $MEET_GEN_MODEL or --model.
//
// Output: captures the agent's stdout/result to the generation log, diffs
// artifacts/ before vs after to learn what was created, and returns/prints a
// structured summary { created:[{type,slug,novelty}], killed:[], duration }.

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  buildClaudeInvocation,
  buildSummary,
  dedupBySignal,
  diffCreated,
  enforceCap,
  partitionByRouting,
  readNovelty,
  resolveModel,
  scanArtifacts,
  summarizeGeneration,
  type ArtifactRef,
  type CreatedArtifact,
  type GenerationSummary,
  type GenInvocationInput,
  type QuarantinedArtifact,
} from "./run-generation-lib.ts";

export interface RunGenerationOptions {
  /** Path to the run-brief markdown the agent consumes (required). */
  briefPath: string;
  /** Where artifacts are saved + what the diff watches. Default "artifacts". */
  artifactsDir?: string;
  /** MAX_ARTIFACTS_PER_RUN cap passed to the agent. Default 3. */
  cap?: number;
  /** Model override (else $MEET_GEN_MODEL, else opus). */
  model?: string;
  /** Repo root (cwd for the spawn). Default process.cwd(). */
  repoRoot?: string;
  /** Run id (provenance). Default derived from the brief's run dir name. */
  runId?: string;
  /** Where the agent's stdout/result is captured. Default <briefDir>/generation-log.txt. */
  logPath?: string;
  /**
   * Injected spawn (TEST SEAM): lets tests assert the argv/system-prompt shape
   * and simulate artifact creation WITHOUT calling claude. Defaults to a real
   * `claude -p` spawn. Signature mirrors the slice of spawnSync we use.
   */
  spawn?: SpawnFn;
  /** Injected env (for resolveModel). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injected clock (ms) for deterministic duration in tests. Defaults to Date.now. */
  now?: () => number;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => { status: number | null; stdout: string; stderr: string };

const defaultSpawn: SpawnFn = (cmd, args, opts) => {
  const res = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
};

/**
 * Run the headless generation step and return a structured summary.
 *
 * 1. Resolve model + paths.
 * 2. Scan artifacts/ BEFORE.
 * 3. Spawn `claude -p` with the generation system prompt (or the injected
 *    spawn in tests).
 * 4. Capture stdout to the generation log.
 * 5. Scan artifacts/ AFTER; diff to learn what was created; read each new
 *    artifact's novelty.
 * 6. Return { created, killed, duration, exit_code }.
 *
 * NEVER throws on a non-zero agent exit — a failed/empty generation is a valid
 * outcome (zero artifacts is a valid run). The summary's exit_code surfaces it.
 */
export async function runGeneration(opts: RunGenerationOptions): Promise<GenerationSummary> {
  const artifactsDir = opts.artifactsDir ?? "artifacts";
  const cap = opts.cap ?? 3;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const env = opts.env ?? process.env;
  const model = resolveModel(opts.model, env);
  const briefDir = dirname(opts.briefPath);
  const runId = opts.runId ?? (basename(briefDir) || new Date().toISOString());
  const logPath = opts.logPath ?? join(briefDir, "generation-log.txt");
  const spawn = opts.spawn ?? defaultSpawn;
  const now = opts.now ?? Date.now;

  const invocationInput: GenInvocationInput = {
    briefPath: opts.briefPath,
    repoRoot,
    artifactsDir,
    cap,
    model,
    runId,
  };
  const { cmd, args } = buildClaudeInvocation(invocationInput);

  // BEFORE snapshot.
  const before = await scanArtifacts(artifactsDir);

  // Invoke the agent headlessly.
  const startedAt = now();
  const result = spawn(cmd, args, { cwd: repoRoot });
  const duration = now() - startedAt;
  const exitCode = result.status ?? -1;

  // Capture the agent's stdout/result (+ stderr tail) to the generation log.
  await mkdir(dirname(logPath), { recursive: true });
  const header =
    `# generation-log — ${runId}\n` +
    `# model: ${model}  cap: ${cap}  exit: ${exitCode}  duration_ms: ${Math.round(duration)}\n` +
    `# brief: ${opts.briefPath}\n\n`;
  const body =
    `===== STDOUT =====\n${result.stdout}\n` +
    (result.stderr.trim() ? `\n===== STDERR =====\n${result.stderr}\n` : "");
  await writeFile(logPath, header + body);

  // AFTER snapshot → diff to learn what the agent created THIS run.
  const after = await scanArtifacts(artifactsDir);
  const createdRefs = diffCreated(before, after);
  const quarantined: QuarantinedArtifact[] = [];

  // DETERMINISTIC BACKSTOPS over whatever the agent actually wrote (the system
  // prompt's dedup + cap rules are advisory; these are structural). Quarantine
  // root is THIS run's dir (alongside the brief), so excess/dups land under
  // index/runs/<id>/{dedup,over-cap}/ for human review, never deleted.
  //
  // 1. PUBLISHED vs DRAFT routing FIRST (Phase 1b — the metadata seam). Outward
  //    drafts (social-post / investor-update-snippet, born approval_status:
  //    "pending") are NOT published and do NOT count against the cap — they route
  //    to the approvals tray. Only internal-audience artifacts (insight-card /
  //    article / podcast / person-brief) are published.
  //
  //    Routing MUST precede dedup: a same-meeting outward draft and a publishable
  //    card can share a signal, and dedup picks the cluster winner by numeric
  //    novelty. If we deduped the MIXED set, a high-novelty unapproved DRAFT could
  //    quarantine the real feed artifact — an unreviewed draft silently
  //    suppressing a published card. Partitioning first guarantees drafts never
  //    participate in dedup against published artifacts (the "drafts never crowd
  //    out feed artifacts" separation). (See PR #12 Medium.)
  const { published, drafts } = await partitionByRouting(createdRefs);

  // 2. IN-RUN DEDUP over the PUBLISHED set ONLY (the core upgrade): two format
  //    passes can land on the same underlying signal in one run. Keep the
  //    highest-value artifact per signal, quarantine the rest. Runs before the cap
  //    so the cap counts only distinct signals. Drafts are intentionally NOT
  //    deduped: they are rare, human-reviewed in the approvals tray, and must
  //    never be silently quarantined by the harness — a reviewer decides their
  //    fate. (Drafts also never dedup against each other for the same reason.)
  const dedup = await dedupBySignal(published, briefDir);
  for (const ref of dedup.quarantined) {
    quarantined.push({ ref: `${ref.type}/${ref.slug}`, reason: "duplicate-signal" });
  }
  const dedupedPublished = dedup.kept;

  // 3. CAP ENFORCEMENT over the PUBLISHED set only: if the agent ignored
  //    MAX_ARTIFACTS_PER_RUN, keep the first `cap` by creation order and
  //    quarantine the excess. Drafts are never cap-quarantined.
  const capped = await enforceCap(dedupedPublished, cap, briefDir);
  for (const ref of capped.quarantined) {
    quarantined.push({ ref: `${ref.type}/${ref.slug}`, reason: "over-cap" });
  }

  // Enrich the published SURVIVORS + the drafts with novelty for the summary.
  const enrich = async (refs: ArtifactRef[]): Promise<CreatedArtifact[]> => {
    const out: CreatedArtifact[] = [];
    for (const ref of refs) {
      out.push({ type: ref.type, slug: ref.slug, novelty: await readNovelty(ref.dir) });
    }
    return out;
  };
  const created = await enrich(capped.kept);
  const draftSummaries = await enrich(drafts);

  return buildSummary({
    created,
    drafts: draftSummaries,
    stdout: result.stdout,
    duration,
    exitCode,
    quarantined,
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(
    "usage: bun harness/feed-run/scripts/run-generation.ts --brief PATH " +
      "[--artifacts-dir DIR] [--cap N] [--model M] [--repo-root DIR] " +
      "[--run-id ID] [--log PATH]",
  );
  process.exit(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const take = (i: number): string => {
    const v = args[i];
    if (v === undefined) usage();
    return v;
  };
  let briefPath: string | undefined;
  let artifactsDir = "artifacts";
  let cap = 3;
  let model: string | undefined;
  let repoRoot: string | undefined;
  let runId: string | undefined;
  let logPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--brief":
        briefPath = take(++i);
        break;
      case "--artifacts-dir":
        artifactsDir = take(++i);
        break;
      case "--cap": {
        const n = Number(take(++i));
        if (!Number.isInteger(n) || n < 0) {
          console.error("--cap must be a non-negative integer");
          process.exit(2);
        }
        cap = n;
        break;
      }
      case "--model":
        model = take(++i);
        break;
      case "--repo-root":
        repoRoot = take(++i);
        break;
      case "--run-id":
        runId = take(++i);
        break;
      case "--log":
        logPath = take(++i);
        break;
      case "--help":
      case "-h":
        usage();
      default:
        usage();
    }
  }
  if (!briefPath) usage();

  const summary = await runGeneration({
    briefPath,
    artifactsDir,
    cap,
    model,
    repoRoot,
    runId,
    logPath,
  });
  console.error(`[run-generation] ${summarizeGeneration(summary)}`);
  // Structured summary to stdout (so a caller/pipe consumes it).
  console.log(JSON.stringify(summary, null, 2));
  // A failed agent exit is surfaced in the summary but is NOT a runner failure
  // (zero artifacts is a valid run). Exit 0 unless the spawn itself never ran.
  process.exit(summary.exit_code === -1 ? 1 : 0);
}
