// run-generation-lib.ts — the testable plumbing for the headless generation
// runner (spec §7/§8 — the piece that turns a run-brief into artifacts by
// invoking a generation AGENT HEADLESSLY).
//
// THE BOUNDARY (base SPEC + corpus-nav SPEC, non-negotiable): the index / query
// / feed-run SCRIPTS make NO model calls — they surface, the agent judges. This
// runner is the ORCHESTRATION layer that sits ABOVE that boundary: it is
// explicitly allowed to invoke the agent CLI (`claude -p`, the
// reference_claude_cli_headless recipe). It does not itself reason about
// transcripts; it spawns an agent that does. Everything reasoning-shaped stays
// inside the agent's run; everything here is deterministic plumbing:
//   - building the correct `claude -p` argv + system prompt,
//   - diffing artifacts/ before vs after to learn what the agent created,
//   - parsing a structured summary out of that diff.
//
// All of THIS file is pure + side-effect-free at import time, so the tests can
// assert the invocation shape WITHOUT ever calling claude or generating.

import { readdir, readFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactType } from "../../_shared/lib/artifact.ts";
import { ARTIFACT_TYPES } from "../../_shared/lib/artifact.ts";

// ---------------------------------------------------------------------------
// Defaults + config
// ---------------------------------------------------------------------------

/**
 * Default model for the headless generation agent. Hunter's best-model default
 * (per feedback_best_available_model): generation quality matters, so `opus`.
 * Overridable via $MEET_GEN_MODEL or the --model flag.
 */
export const DEFAULT_GEN_MODEL = "opus";

/** The env var that overrides the default model (a --model flag wins over it). */
export const GEN_MODEL_ENV = "MEET_GEN_MODEL";

/**
 * Resolve the generation model: an explicit flag wins, else $MEET_GEN_MODEL,
 * else the `opus` default. Pure — `env` is injected so tests don't touch
 * process.env.
 */
export function resolveModel(
  flag: string | undefined,
  env: Record<string, string | undefined>,
): string {
  if (flag && flag.trim()) return flag.trim();
  const fromEnv = env[GEN_MODEL_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return DEFAULT_GEN_MODEL;
}

// ---------------------------------------------------------------------------
// The claude -p invocation
// ---------------------------------------------------------------------------

export interface GenInvocationInput {
  /** Absolute (or repo-relative) path to the run-brief markdown the agent reads. */
  briefPath: string;
  /** Repo root the agent runs the skills from (cwd for the spawn). */
  repoRoot: string;
  /** Where survivors are saved + what the diff watches. */
  artifactsDir: string;
  /** Hard cap on artifacts this run may publish (MAX_ARTIFACTS_PER_RUN). */
  cap: number;
  /** Resolved model id (opus by default). */
  model: string;
  /** The run id (for log + provenance), ISO-ish. */
  runId: string;
}

/**
 * The headless system prompt (the reference_claude_cli_headless recipe REQUIRES
 * `--system-prompt` to fully override the default so the run is clean — no
 * SessionStart hook / skill chatter polluting the agent's work). This is the
 * agent's marching orders: consume the brief, run the artifact skills, apply the
 * adversarial novelty critic, respect the cap, save + append the ledger.
 *
 * Pure string builder so a test can assert its shape without spawning anything.
 */
export function buildSystemPrompt(input: GenInvocationInput): string {
  return [
    "You are the distillery feed-run GENERATION agent, invoked headlessly.",
    "You produce feed artifacts from meeting transcripts. Judgment is yours;",
    "the orchestrator already did the deterministic plumbing (index → distill →",
    "query → brief). Generation quality is the whole point — be ruthless.",
    "",
    "RUN CONTEXT (paths are authoritative; do not invent others):",
    `- run-brief:    ${input.briefPath}`,
    `- repo root:    ${input.repoRoot}`,
    `- artifacts to: ${input.artifactsDir}`,
    `- run id:       ${input.runId}`,
    `- MAX_ARTIFACTS_PER_RUN (hard cap): ${input.cap}`,
    "",
    "DO, in order:",
    "1. Read the run-brief at the path above. It lists the selected transcripts",
    "   (recency window + one rotating deep-dive) with titles, paths, source,",
    "   match-context snippets, the preferences panel, the embedded FEEDBACK",
    "   SUMMARY, and the prior-artifact baseline. It tells you WHERE to look; you",
    "   do the looking.",
    "1a. CLOSE THE PREFERENCE LOOP FIRST (MANDATORY — distill-preferences skill).",
    "    BEFORE generating anything, turn feedback into preferences: read the",
    "    brief's embedded feedback summary (and open the artifacts it points at",
    "    that carry real signal — less/wrong/promote/notes), then update ONLY the",
    `    [learned] bullets in ${input.repoRoot}/PREFERENCES.md per`,
    "    skills/distill-preferences/SKILL.md. NEVER touch human-authored (untagged)",
    "    lines — they are authoritative; drop any learned candidate that",
    "    contradicts one. Be conservative: require >=2 consistent signals before a",
    "    generalization and cite the evidence counts in each bullet (e.g. '(5x more",
    "    + 3 save on founding-wedge card, Jun 2026)'). Zero updates is valid. This",
    "    step is NOT skippable — it is the only thing that turns reactions into",
    "    learned preferences. Then RE-READ PREFERENCES.md and generate against the",
    "    freshly-updated file, not the pre-distill snapshot embedded in the brief.",
    "2. Read the ACTUAL transcript files at the paths in the brief (the brief",
    "   surfaced paths only — never bodies).",
    "3. For each transcript, run the artifact skills appropriate to the material:",
    "   extract-insights (insight cards), write-article (longform), make-podcast",
    "   (micro-podcasts). Pick the format the material earns; not every",
    "   transcript yields an artifact.",
    "3a. ONE SIGNAL → ONE ARTIFACT (in-run dedup, MANDATORY). Before you pick an",
    "    angle for ANY new artifact, read (a) the surfaced ledger",
    "    (index/surfaced.json) and (b) the artifacts you have ALREADY created in",
    "    THIS run. If a signal/thread (e.g. a specific quantified-claim drift, a",
    "    single-voice topic) is already used by a prior artifact OR by one you",
    "    just made this run, SKIP it — do NOT make a second artifact (e.g. a card",
    "    AND a podcast) on the same underlying signal, even in a different format.",
    "    Across all formats, at most ONE artifact ships per underlying signal.",
    "    Spend the cap on DISTINCT signals.",
    "4. Run each skill's baked-in novelty-scan + the MANDATORY adversarial",
    "   novelty critic. Kill anything that re-angles a prior artifact, duplicates",
    "   a signal already used this run, or clears no novelty bar. ZERO artifacts",
    "   is a valid, good run — quality beats quantity.",
    `5. Publish at most ${input.cap} survivors with save.ts (auto-publish straight`,
    `   to ${input.artifactsDir}). One hero image per artifact at most.`,
    "6. After saving, append each EXAMINED transcript (shipped or not) to the",
    "   surfaced ledger (index/surfaced.json) per skills/feed-run/SKILL.md —",
    "   path, topic_keys, outcome (shipped|examined-no-ship), mode. Do NOT touch",
    "   the deep-dive cursor; the orchestrator already advanced + persisted it.",
    "",
    "CONSTRAINTS:",
    "- Honor PREFERENCES.md as you freshly updated it in step 1a (topics, novelty",
    "  bar, formats) — not the pre-distill snapshot embedded in the brief.",
    `- NEVER exceed the cap of ${input.cap} published artifacts.`,
    "- Anchor every claim to a verbatim transcript quote (verify quotes).",
    "- Stay inside the repo; write artifacts only under the artifacts dir above.",
    "",
    "When you are finished, print a final one-line summary of what you shipped",
    "and what you killed, then stop.",
  ].join("\n");
}

/** The user message that kicks the headless run (short — the system prompt carries the detail). */
export function buildUserMessage(input: GenInvocationInput): string {
  return (
    `Run the distillery feed-run GENERATION step for run ${input.runId}. ` +
    `Read the run-brief at ${input.briefPath} and execute its generation: read ` +
    `the selected transcripts, run the artifact skills with the adversarial ` +
    `novelty critic, publish the best ≤${input.cap} survivors to ` +
    `${input.artifactsDir}, then append the surfaced ledger per ` +
    `skills/feed-run/SKILL.md. Do not advance the deep-dive cursor.`
  );
}

/**
 * Build the full `claude -p` argv (the reference_claude_cli_headless recipe).
 * Returns `{ cmd, args }` so a test asserts the argv shape WITHOUT spawning.
 * Shape: `claude -p "<user msg>" --system-prompt "<full override>" --model <m>`.
 * `--system-prompt` (not `--append-system-prompt`) so the run is clean.
 */
export function buildClaudeInvocation(input: GenInvocationInput): {
  cmd: string;
  args: string[];
} {
  return {
    cmd: "claude",
    args: [
      "-p",
      buildUserMessage(input),
      "--system-prompt",
      buildSystemPrompt(input),
      "--model",
      input.model,
    ],
  };
}

// ---------------------------------------------------------------------------
// Artifact before/after diff
// ---------------------------------------------------------------------------

/** A single artifact folder discovered under artifacts/<type>/<slug>/. */
export interface ArtifactRef {
  type: ArtifactType;
  slug: string;
  /** `<type>/<slug>` — the stable key used for the before/after diff. */
  key: string;
  /** Absolute path to the artifact's folder. */
  dir: string;
}

/**
 * Scan artifacts/ into the set of `<type>/<slug>` folders that contain an
 * artifact.json. Never throws (a missing artifacts dir → empty set), matching
 * the never-throw stance of priorArtifactIndex / readIndex. Pure-ish: only
 * reads the filesystem, no model calls.
 */
export async function scanArtifacts(artifactsDir: string): Promise<ArtifactRef[]> {
  const refs: ArtifactRef[] = [];
  for (const type of ARTIFACT_TYPES) {
    const typeDir = join(artifactsDir, type);
    let slugs: string[];
    try {
      slugs = (await readdir(typeDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // type dir absent → no artifacts of this type
    }
    for (const slug of slugs) {
      const dir = join(typeDir, slug);
      // Only count folders that actually hold an artifact.json (a half-written
      // or stray dir is not a published artifact).
      try {
        await readFile(join(dir, "artifact.json"), "utf8");
      } catch {
        continue;
      }
      refs.push({ type, slug, key: `${type}/${slug}`, dir });
    }
  }
  return refs;
}

export interface CreatedArtifact {
  type: ArtifactType;
  slug: string;
  /**
   * The novelty score the agent recorded on the artifact, if any. Read from the
   * artifact.json's quality.notes / a `novelty` field when present — best-effort
   * provenance, never load-bearing.
   */
  novelty?: number | string;
}

/**
 * Diff a before-set against an after-set of artifact refs: which keys are NEW
 * (created this run). Pure — operates on the two scanned lists. Returns the
 * after-refs whose key was not in `before`.
 */
export function diffCreated(before: ArtifactRef[], after: ArtifactRef[]): ArtifactRef[] {
  const beforeKeys = new Set(before.map((r) => r.key));
  return after.filter((r) => !beforeKeys.has(r.key));
}

/**
 * Resolve a stable CREATION ORDER for a set of newly-created artifact refs:
 * earliest first. The order key is the artifact.json's `generated_at` ISO field
 * (the agent stamps it when it saves), falling back to the file's mtime, then
 * the `<type>/<slug>` key for a deterministic tie-break. Pure-ish (reads mtime
 * only when generated_at is absent). Never throws — an unreadable artifact sorts
 * last by an empty key.
 */
export async function orderByCreation(refs: ArtifactRef[]): Promise<ArtifactRef[]> {
  const keyed = await Promise.all(
    refs.map(async (ref) => {
      let order = "";
      try {
        const raw = await readFile(join(ref.dir, "artifact.json"), "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.generated_at === "string" && parsed.generated_at.trim()) {
          order = parsed.generated_at;
        }
      } catch {
        /* fall through to mtime */
      }
      if (!order) {
        try {
          order = (await stat(join(ref.dir, "artifact.json"))).mtime.toISOString();
        } catch {
          order = "";
        }
      }
      return { ref, order };
    }),
  );
  keyed.sort((a, b) => a.order.localeCompare(b.order) || a.ref.key.localeCompare(b.ref.key));
  return keyed.map((k) => k.ref);
}

export interface CapEnforcement {
  /** The refs kept in artifacts/ (the first `cap` by creation order). */
  kept: ArtifactRef[];
  /** The refs MOVED out of artifacts/ into the over-cap quarantine. */
  quarantined: ArtifactRef[];
  /** Absolute dir the excess was moved to (only set when something quarantined). */
  quarantineDir?: string;
}

/**
 * DETERMINISTICALLY enforce MAX_ARTIFACTS_PER_RUN (review Medium #3). The cap in
 * the system prompt is advisory — a non-compliant or prompt-injected agent can
 * write N+k artifacts and save.ts auto-publishes them. This is the structural
 * backstop: after the before/after diff, if the agent created MORE than `cap`
 * artifacts THIS run, keep the first `cap` by creation order and MOVE the excess
 * out of `artifacts/` into `index/runs/<id>/over-cap/<type>/<slug>/` so they are
 * no longer published. Returns what was kept vs quarantined for the run log.
 *
 * Only ever touches THIS run's newly-created artifacts (the diff result) — prior
 * artifacts are never moved. A no-op when `created.length <= cap`.
 */
export async function enforceCap(
  created: ArtifactRef[],
  cap: number,
  quarantineRoot: string,
): Promise<CapEnforcement> {
  if (created.length <= cap) {
    return { kept: created, quarantined: [] };
  }
  const ordered = await orderByCreation(created);
  const kept = ordered.slice(0, cap);
  const excess = ordered.slice(cap);
  const quarantineDir = join(quarantineRoot, "over-cap");
  for (const ref of excess) {
    const dest = join(quarantineDir, ref.type, ref.slug);
    await mkdir(join(dest, ".."), { recursive: true });
    await rename(ref.dir, dest);
  }
  return { kept, quarantined: excess, quarantineDir };
}

/**
 * Read a best-effort novelty value off an artifact.json. Looks for a top-level
 * `novelty` field, else a `quality.notes` string. Never throws (missing/garbage
 * → undefined). Provenance only — the summary tolerates its absence.
 */
export async function readNovelty(artifactDir: string): Promise<number | string | undefined> {
  try {
    const raw = await readFile(join(artifactDir, "artifact.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.novelty === "number" || typeof parsed.novelty === "string") {
      return parsed.novelty as number | string;
    }
    const q = parsed.quality as Record<string, unknown> | undefined;
    if (q && typeof q.novelty === "number") return q.novelty;
    if (q && typeof q.notes === "string" && q.notes.trim()) return q.notes;
  } catch {
    // no readable novelty — fine
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// In-run dedup (the core upgrade — Hunter-approved)
// ---------------------------------------------------------------------------
//
// THE PROBLEM: the generation agent runs multiple artifact-format passes
// (extract-insights, write-article, make-podcast) inside ONE headless run. They
// can't see each other's output, so two passes can land on the SAME underlying
// signal — observed: a card AND a podcast both on the "$2M→100k fundraise drift".
// One run should ship at most ONE artifact per underlying signal.
//
// APPROACH (option b, post-generation pass) — chosen because the runner spawns a
// SINGLE agent, so it CANNOT interleave the agent's internal per-format passes
// (option a needs separately-spawned sequential agents, which this architecture
// doesn't have). Instead we detect same-signal artifacts AFTER the run by their
// deterministic fingerprint and quarantine the lower-value duplicate. The system
// prompt is ALSO hardened (read the ledger + already-created artifacts before
// picking an angle) so the agent avoids the dup in the first place — the
// post-pass is the structural backstop when it doesn't.

/** The fingerprint that decides whether two artifacts cover the same signal. */
export interface SignalFingerprint {
  /** Sorted, normalized source_transcripts — the underlying material. */
  sources: string[];
  /** The novelty lead/topic the artifact claims (quality.notes / novelty), normalized. */
  lead: string;
}

/** Normalize a transcript path for comparison (basename, lowercased, trimmed). */
function normSource(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.trim().toLowerCase();
}

/** Pull the comparable signal fingerprint off an artifact.json. Never throws. */
export async function readSignalFingerprint(artifactDir: string): Promise<SignalFingerprint> {
  try {
    const raw = await readFile(join(artifactDir, "artifact.json"), "utf8");
    const a = JSON.parse(raw) as Record<string, unknown>;
    const sources = Array.isArray(a.source_transcripts)
      ? (a.source_transcripts as unknown[])
          .filter((s): s is string => typeof s === "string")
          .map(normSource)
          .sort()
      : [];
    let lead = "";
    const q = a.quality as Record<string, unknown> | undefined;
    if (q && typeof q.notes === "string") lead = q.notes;
    if (!lead && typeof a.novelty === "string") lead = a.novelty as string;
    // Reduce the lead to a stable signal key: lowercased alphanumeric tokens.
    lead = lead.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return { sources, lead };
  } catch {
    return { sources: [], lead: "" };
  }
}

/**
 * Do two fingerprints describe the SAME underlying signal? True when they share
 * source transcripts AND their novelty leads overlap (same `[novelty]` lead/
 * topic). Sharing sources alone is NOT enough (two genuinely distinct angles can
 * cite the same meeting); the lead overlap is what makes it a DUPLICATE.
 */
export function sameSignal(a: SignalFingerprint, b: SignalFingerprint): boolean {
  const shareSource = a.sources.some((s) => b.sources.includes(s));
  if (!shareSource) return false;
  if (!a.lead || !b.lead) return false;
  // Lead overlap: significant shared tokens (length>3) between the two leads.
  const at = new Set(a.lead.split(" ").filter((t) => t.length > 3));
  const bt = new Set(b.lead.split(" ").filter((t) => t.length > 3));
  if (at.size === 0 || bt.size === 0) return false;
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared++;
  // Same signal if leads share >= 2 significant tokens (or one lead is a subset).
  return shared >= 2 || shared === Math.min(at.size, bt.size);
}

/**
 * Richer-synthesis precedence for the value tie-break: an article (longform
 * synthesis) > a podcast (narrated synthesis) > an insight-card (atomic). Used
 * only when two same-signal artifacts have equal/absent novelty scores.
 */
const FORMAT_VALUE: Record<ArtifactType, number> = {
  article: 3,
  podcast: 2,
  "insight-card": 1,
};

export interface DedupResult {
  /** Refs that survive (one winner per signal cluster + all unique artifacts). */
  kept: ArtifactRef[];
  /** Refs MOVED out of artifacts/ as same-signal duplicates of a kept artifact. */
  quarantined: ArtifactRef[];
  /** Absolute dir the dups were moved to (only set when something quarantined). */
  quarantineDir?: string;
}

/**
 * DETERMINISTIC in-run dedup pass. Clusters THIS run's newly-created artifacts by
 * same-underlying-signal (shared source + overlapping novelty lead), keeps the
 * HIGHEST-VALUE artifact in each cluster, and MOVES the rest into
 * `index/runs/<id>/dedup/<type>/<slug>/`. "Value" = numeric novelty (higher
 * wins), tie-broken by richer-format precedence, then key (stable).
 *
 * Only touches THIS run's artifacts (the diff result). A no-op when no two share
 * a signal. Never deletes — quarantines, so a human can review false positives.
 */
export async function dedupBySignal(
  created: ArtifactRef[],
  quarantineRoot: string,
): Promise<DedupResult> {
  if (created.length < 2) return { kept: created, quarantined: [] };

  // Enrich each ref with its fingerprint + a numeric value for the keep choice.
  const enriched = await Promise.all(
    created.map(async (ref) => {
      const fp = await readSignalFingerprint(ref.dir);
      const novelty = await readNovelty(ref.dir);
      const noveltyNum = typeof novelty === "number" ? novelty : -1;
      return { ref, fp, noveltyNum };
    }),
  );

  // Greedy single-link clustering by sameSignal.
  const used = new Set<number>();
  const winners: typeof enriched = [];
  const losers: ArtifactRef[] = [];
  for (let i = 0; i < enriched.length; i++) {
    if (used.has(i)) continue;
    const cluster = [enriched[i]!];
    used.add(i);
    for (let j = i + 1; j < enriched.length; j++) {
      if (used.has(j)) continue;
      if (cluster.some((c) => sameSignal(c.fp, enriched[j]!.fp))) {
        cluster.push(enriched[j]!);
        used.add(j);
      }
    }
    if (cluster.length === 1) {
      winners.push(cluster[0]!);
      continue;
    }
    // Pick the highest-value member; the rest are duplicates → quarantine.
    cluster.sort(
      (a, b) =>
        b.noveltyNum - a.noveltyNum ||
        FORMAT_VALUE[b.ref.type] - FORMAT_VALUE[a.ref.type] ||
        a.ref.key.localeCompare(b.ref.key),
    );
    winners.push(cluster[0]!);
    for (const dup of cluster.slice(1)) losers.push(dup.ref);
  }

  if (losers.length === 0) {
    return { kept: created, quarantined: [] };
  }
  const quarantineDir = join(quarantineRoot, "dedup");
  for (const ref of losers) {
    const dest = join(quarantineDir, ref.type, ref.slug);
    await mkdir(join(dest, ".."), { recursive: true });
    await rename(ref.dir, dest);
  }
  const loserKeys = new Set(losers.map((r) => r.key));
  return {
    kept: created.filter((r) => !loserKeys.has(r.key)),
    quarantined: losers,
    quarantineDir,
  };
}

// ---------------------------------------------------------------------------
// The structured run summary
// ---------------------------------------------------------------------------

export interface GenerationSummary {
  /** Artifacts created this run (from the before/after diff). */
  created: CreatedArtifact[];
  /**
   * Artifacts the agent reported KILLING (clearing no novelty bar). Best-effort:
   * parsed from the agent's stdout summary line; absent → empty.
   */
  killed: KilledArtifact[];
  /** Wall-clock duration of the headless run, in ms. */
  duration: number;
  /** The exit status of the `claude -p` spawn (0 = clean). */
  exit_code: number;
  /**
   * Artifacts the runner QUARANTINED post-generation (deterministic backstops):
   * same-signal duplicates (in-run dedup) and over-cap excess. Each as
   * `<type>/<slug>` with the reason. Empty when nothing was quarantined.
   */
  quarantined?: QuarantinedArtifact[];
}

export interface QuarantinedArtifact {
  /** `<type>/<slug>` of the quarantined artifact. */
  ref: string;
  /** Why the runner pulled it from artifacts/. */
  reason: "duplicate-signal" | "over-cap";
}

export interface KilledArtifact {
  /** A short label the agent used for the killed candidate (slug-ish). */
  label: string;
  /** Why it was killed, if the agent said. */
  reason?: string;
}

/**
 * Parse the count/labels of KILLED candidates out of the agent's stdout. The
 * agent prints a free-form final summary; we look for a "killed" line and pull
 * `label (reason)` shaped fragments. Best-effort, never throws, never required
 * (the diff is the authoritative record of what shipped; killed is provenance).
 *
 * Recognized shapes (case-insensitive), e.g.:
 *   "killed: foo-card (re-angles prior), bar-podcast (no novelty)"
 *   "Killed 2: foo (dup), bar (thin)"
 */
export function parseKilled(stdout: string): KilledArtifact[] {
  const out: KilledArtifact[] = [];
  for (const line of stdout.split("\n")) {
    const m = /killed[^:]*:\s*(.+)$/i.exec(line.trim());
    if (!m) continue;
    const body = m[1]!.trim();
    if (!body || /^(none|0|nothing)\b/i.test(body)) return [];
    // Split on commas at top level; each fragment is `label (reason)`.
    for (const frag of body.split(",")) {
      const f = frag.trim();
      if (!f) continue;
      const lm = /^(.+?)\s*\(([^)]*)\)\s*$/.exec(f);
      if (lm) {
        out.push({ label: lm[1]!.trim(), reason: lm[2]!.trim() || undefined });
      } else {
        out.push({ label: f });
      }
    }
    // First "killed:" line wins (the agent's final summary).
    if (out.length) break;
  }
  return out;
}

/**
 * Assemble the structured generation summary from the before/after artifact
 * diff + the agent's stdout + timing. `createdRefs` is the diff result
 * (diffCreated) ALREADY enriched with novelty (the caller reads novelty off
 * disk). Pure — no I/O.
 */
export function buildSummary(args: {
  created: CreatedArtifact[];
  stdout: string;
  duration: number;
  exitCode: number;
  quarantined?: QuarantinedArtifact[];
}): GenerationSummary {
  return {
    created: args.created,
    killed: parseKilled(args.stdout),
    duration: args.duration,
    exit_code: args.exitCode,
    ...(args.quarantined && args.quarantined.length ? { quarantined: args.quarantined } : {}),
  };
}

/** A one-line human summary of a generation run (mirrors summarizeRun's style). */
export function summarizeGeneration(s: GenerationSummary): string {
  const created = s.created.map((c) => `${c.type}/${c.slug}`).join(", ") || "none";
  const q = s.quarantined?.length
    ? ` quarantined=${s.quarantined.length} [${s.quarantined.map((x) => `${x.ref}:${x.reason}`).join(", ")}]`
    : "";
  return (
    `generation: created=${s.created.length} [${created}] ` +
    `killed=${s.killed.length}${q} ` +
    `duration=${Math.round(s.duration)}ms exit=${s.exit_code}`
  );
}
