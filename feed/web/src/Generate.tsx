// Generate.tsx — the on-demand "Generate" affordance (spec §8). A quiet,
// premium control next to Rescan: tap it to fire the feed-run loop without
// waiting for the morning cron. POST /api/generate → 202 { run_id }, then poll
// GET /api/generate/:run_id until the run finishes, then nudge the feed to
// rescan. Matches the masthead's quiet-link aesthetic (DESIGN_MEMORY tokens) —
// no loud button; a hairline affordance with a running shimmer.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Glyph } from "./Card.tsx";

const POLL_MS = 4000;
/** Give up polling after this long (the run keeps going server-side regardless). */
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

type RunStatus = {
  run_id: string;
  status: "running" | "done" | "aborted" | "unknown";
  dry_run: boolean;
  artifacts_published?: string[];
  outcome?: string;
};

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; runId: string }
  | { kind: "done"; count: number; dryRun: boolean }
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
        const res = await fetch(`/api/generate/${encodeURIComponent(runId)}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const s = (await res.json()) as RunStatus;
        if (s.status === "done" || s.status === "aborted") {
          clearPoll();
          const count = s.artifacts_published?.length ?? 0;
          setState({ kind: "done", count, dryRun: s.dry_run });
          if (!s.dry_run && count > 0) onComplete?.();
          return;
        }
      } catch {
        // transient — keep polling; the run is server-side regardless
      }
      if (Date.now() - startedAt.current > POLL_TIMEOUT_MS) {
        clearPoll();
        setState({ kind: "error", message: "still running — check back later" });
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
      const res = await fetch("/api/generate", {
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
      setState({ kind: "running", runId: run_id });
      pollTimer.current = window.setTimeout(() => void poll(run_id), POLL_MS);
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [poll]);

  const busy = state.kind === "starting" || state.kind === "running";

  // Completion / error states auto-clear back to idle so the control stays quiet.
  useEffect(() => {
    if (state.kind === "done" || state.kind === "error") {
      const t = window.setTimeout(() => setState({ kind: "idle" }), 6000);
      return () => window.clearTimeout(t);
    }
  }, [state]);

  let label: ReactNode = (
    <>
      <Glyph name="spark" size={14} /> Generate
    </>
  );
  if (busy) {
    label = (
      <>
        <span className="gen-spinner" aria-hidden="true" /> mining corpus…
      </>
    );
  } else if (state.kind === "done") {
    label =
      state.count > 0
        ? `${state.count} new artifact${state.count === 1 ? "" : "s"} — rescan to view`
        : state.dryRun
          ? "preview ready (nothing published)"
          : "nothing new this run";
  } else if (state.kind === "error") {
    label = state.message;
  }

  return (
    <button
      type="button"
      className={`quiet-link gen-control${busy ? " gen-busy" : ""}`}
      onClick={() => void start()}
      disabled={busy}
      aria-live="polite"
    >
      {label}
    </button>
  );
}
