// Generate.tsx — the on-demand "Generate" affordance (spec §8) with REAL staged
// progress (replaces the indefinite "mining corpus…" spinner). Tap to fire the
// feed-run loop; POST /api/generate → 202 { run_id }; then poll GET
// /api/generate/:run_id every ~2s and render three HONEST signals:
//
//   1. STAGE TRACK — pills/checkmarks ticking through Index → Distill → Query →
//      Brief → Generating → Done (the orchestrator's run-log steps).
//   2. PROGRESS BAR — fills by completed-stages, and within Generating by
//      artifacts_produced / cap. NO faked percentage: the bar only moves on real
//      stage/artifact signal.
//   3. ACTIVITY LINE — latest_activity from progress.jsonl (e.g. "Drafting
//      insight card…"), degrading silently to the stage label when absent.
//
// done → "N new artifacts — view feed" + refresh. failed/stalled → a clear
// terminal state with Retry, NOT an eternal spinner. Matches Folio/DESIGN_MEMORY
// tokens; phone-responsive.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Glyph } from "./Card.tsx";
import { apiFetch } from "./auth.ts";

const POLL_MS = 2000;
/** Give up polling after this long (the run keeps going server-side regardless). */
const POLL_TIMEOUT_MS = 25 * 60 * 1000;

/** The structured progress object from GET /api/generate/:run_id. */
type RunProgress = {
  run_id: string;
  status: "running" | "done" | "failed" | "stalled";
  stages: { step: string; status: string }[];
  current_stage: string | null;
  artifacts_produced: number;
  cap: number;
  drafts_produced: number;
  latest_activity: string | null;
  started_at: string;
  elapsed_ms: number;
  done: boolean;
  dry_run: boolean;
  artifacts_published: string[];
};

/** The compact display track: the raw pipeline steps collapse into these labels. */
const TRACK: { key: string; label: string; steps: string[] }[] = [
  { key: "index", label: "Index", steps: ["index"] },
  { key: "distill", label: "Distill", steps: ["distill"] },
  { key: "query", label: "Query", steps: ["query-recency", "query-deepdive"] },
  { key: "brief", label: "Brief", steps: ["brief"] },
  { key: "generate", label: "Generating", steps: ["generate", "guard", "verify-distill", "save"] },
];

const TERMINAL_OK = new Set(["ok", "skipped", "degraded"]);
const TERMINAL_BAD = new Set(["failed", "aborted"]);

type TrackState = "pending" | "active" | "done" | "failed";

/** Reduce the raw stages into the 5 display segments + their states. */
function trackStates(p: RunProgress): { key: string; label: string; state: TrackState }[] {
  const byStep = new Map(p.stages.map((s) => [s.step, s.status]));
  return TRACK.map((seg) => {
    const statuses = seg.steps.map((s) => byStep.get(s) ?? "pending");
    let state: TrackState = "pending";
    if (statuses.some((s) => TERMINAL_BAD.has(s))) state = "failed";
    else if (statuses.some((s) => s === "active")) state = "active";
    else if (statuses.every((s) => TERMINAL_OK.has(s))) state = "done";
    else if (statuses.some((s) => TERMINAL_OK.has(s))) state = "active"; // partial group → in flight
    return { key: seg.key, label: seg.label, state };
  });
}

/**
 * Honest fill fraction 0..1. Completed display-segments each contribute an equal
 * share; while the Generating segment is in flight, ITS share fills by
 * artifacts_produced / cap. No time-based motion — only real signal moves the bar.
 */
function fillFraction(p: RunProgress): number {
  if (p.status === "done") return 1;
  const segs = trackStates(p);
  const n = segs.length;
  let filled = 0;
  for (let i = 0; i < n; i++) {
    const seg = segs[i]!;
    if (seg.state === "done") {
      filled += 1;
    } else if (seg.state === "active") {
      if (seg.key === "generate" && p.cap > 0) {
        filled += Math.min(1, p.artifacts_produced / p.cap);
      } else {
        filled += 0.5; // a non-generate stage in flight = half that segment
      }
      break; // nothing past the active segment counts
    } else {
      break; // first pending segment stops the fill
    }
  }
  return Math.max(0, Math.min(1, filled / n));
}

function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** Title-case a raw stage key for the fallback activity label. */
function stageLabel(p: RunProgress): string {
  const seg = trackStates(p).find((s) => s.state === "active");
  if (seg) {
    if (seg.key === "generate") return "Generating artifacts…";
    return `${seg.label}…`;
  }
  return "Working…";
}

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; runId: string; progress: RunProgress | null }
  | { kind: "done"; count: number; dryRun: boolean }
  | { kind: "stalled"; runId: string }
  | { kind: "error"; message: string };

export function GenerateControl({ onComplete }: { onComplete?: () => void }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const pollTimer = useRef<number | null>(null);
  const startedAt = useRef<number>(0);

  const clearPoll = useCallback(() => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => () => clearPoll(), [clearPoll]);

  const poll = useCallback(
    async (runId: string) => {
      try {
        const res = await apiFetch(`/api/generate/${encodeURIComponent(runId)}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const p = (await res.json()) as RunProgress;

        if (p.status === "done") {
          clearPoll();
          const count = p.artifacts_published.length || p.artifacts_produced;
          setState({ kind: "done", count, dryRun: p.dry_run });
          if (!p.dry_run && count > 0) onComplete?.();
          return;
        }
        if (p.status === "failed") {
          clearPoll();
          setState({ kind: "error", message: "run failed — nothing published" });
          return;
        }
        if (p.status === "stalled") {
          clearPoll();
          setState({ kind: "stalled", runId });
          return;
        }
        // still running — render the live progress.
        setState({ kind: "running", runId, progress: p });
      } catch {
        // transient — keep polling; the run is server-side regardless. Don't
        // wipe the last-good progress (keeps the bar from snapping back).
      }
      if (Date.now() - startedAt.current > POLL_TIMEOUT_MS) {
        clearPoll();
        setState({ kind: "stalled", runId });
        return;
      }
      pollTimer.current = window.setTimeout(() => void poll(runId), POLL_MS);
    },
    [clearPoll, onComplete],
  );

  const start = useCallback(async () => {
    setState({ kind: "starting" });
    startedAt.current = Date.now();
    try {
      const res = await apiFetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}), // daily, not dry — the real run
      });
      if (res.status === 409) {
        setState({ kind: "error", message: "a run is already in progress" });
        return;
      }
      if (res.status === 401) {
        setState({ kind: "error", message: "sign in to generate" });
        return;
      }
      if (res.status !== 202) throw new Error(`generate ${res.status}`);
      const { run_id } = (await res.json()) as { run_id: string };
      setState({ kind: "running", runId: run_id, progress: null });
      pollTimer.current = window.setTimeout(() => void poll(run_id), POLL_MS);
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [poll]);

  // Completion / error states auto-clear back to idle so the control stays quiet.
  // (Stalled/error stay until the user acts via Retry/dismiss — handled below.)
  useEffect(() => {
    if (state.kind === "done") {
      const t = window.setTimeout(() => setState({ kind: "idle" }), 8000);
      return () => window.clearTimeout(t);
    }
  }, [state]);

  // ---- IDLE: the quiet hairline trigger ---------------------------------
  if (state.kind === "idle") {
    return (
      <button
        type="button"
        className="quiet-link gen-control"
        onClick={() => void start()}
        aria-live="polite"
      >
        <Glyph name="spark" size={14} /> Generate
      </button>
    );
  }

  // ---- DONE: a quiet confirmation ---------------------------------------
  if (state.kind === "done") {
    const label =
      state.count > 0
        ? `${state.count} new artifact${state.count === 1 ? "" : "s"} — view feed`
        : state.dryRun
          ? "preview ready (nothing published)"
          : "nothing new this run";
    return (
      <button
        type="button"
        className="quiet-link gen-control gen-done"
        onClick={() => setState({ kind: "idle" })}
        aria-live="polite"
      >
        <Glyph name="spark" size={14} /> {label}
      </button>
    );
  }

  // ---- ERROR / STALLED: a clear terminal state with Retry (no eternal spin)
  if (state.kind === "error" || state.kind === "stalled") {
    const msg =
      state.kind === "stalled"
        ? "run stalled — no progress for a while"
        : state.message;
    return (
      <div className="gen-progress gen-progress--error" role="status" aria-live="assertive">
        <div className="gen-progress-line">
          <span className="gen-progress-dot gen-progress-dot--error" aria-hidden="true" />
          <span className="gen-progress-activity">{msg}</span>
          <button type="button" className="gen-retry" onClick={() => void start()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ---- STARTING / RUNNING: the live staged progress panel ---------------
  const p = state.kind === "running" ? state.progress : null;
  const segs = p ? trackStates(p) : TRACK.map((s) => ({ key: s.key, label: s.label, state: "pending" as TrackState }));
  const fill = p ? fillFraction(p) : 0;
  const activity: ReactNode = p
    ? p.latest_activity ?? stageLabel(p)
    : "Starting run…";
  const elapsedMs = p?.elapsed_ms ?? (Date.now() - startedAt.current);
  const produced = p?.artifacts_produced ?? 0;
  const cap = p?.cap ?? 3;
  const inGenerate = segs.find((s) => s.key === "generate")?.state === "active";

  return (
    <div className="gen-progress" role="status" aria-live="polite">
      {/* Stage track — pills tick through Index → … → Generating */}
      <ol className="gen-track" aria-label="generation stages">
        {segs.map((s) => (
          <li key={s.key} className={`gen-stage gen-stage--${s.state}`}>
            <span className="gen-stage-mark" aria-hidden="true">
              {s.state === "done" ? "✓" : s.state === "failed" ? "×" : ""}
            </span>
            <span className="gen-stage-label">{s.label}</span>
          </li>
        ))}
      </ol>

      {/* Honest progress bar — fills only on real stage/artifact signal */}
      <div className="gen-bar" aria-hidden="true">
        <div className="gen-bar-fill" style={{ width: `${Math.round(fill * 100)}%` }} />
      </div>

      {/* Live activity line + counts */}
      <div className="gen-progress-line">
        <span className="gen-progress-dot" aria-hidden="true" />
        <span className="gen-progress-activity">{activity}</span>
      </div>
      <div className="gen-progress-meta">
        {inGenerate || produced > 0
          ? `${produced} produced · cap ${cap} · ${fmtElapsed(elapsedMs)} elapsed`
          : `${fmtElapsed(elapsedMs)} elapsed`}
      </div>
    </div>
  );
}
