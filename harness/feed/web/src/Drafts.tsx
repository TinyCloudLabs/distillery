// Drafts.tsx — the APPROVALS / DRAFTS tray (Phase 1a keystone UI).
//
// The other side of the routing seam: outward artifacts the skills stamped
// approval_status:"pending" (social-post, investor-update-snippet, quote-card,
// person-brief) route here instead of to the published feed. Each draft shows
// a type badge + body + the three tray actions, modelled on the FeedbackBar
// component patterns (DESIGN_MEMORY tokens, the Folio look):
//
//   approve → POST /api/drafts/:id/approve — the NEW primary action. Flips the
//             artifact to "approved" on disk; it leaves the tray and appears in
//             the published feed on the next load.
//   kill    → POST /api/drafts/:id/kill — a "less"/hide on a draft (quarantines
//             it server-side, logs a `less` feedback event). Leaves the tray.
//   expand  → POST /api/drafts/:id/expand — the "promote"/expand signal (logs a
//             `promote` event; deeper-artifact expansion is a later step). The
//             draft STAYS in the tray, pending approve/kill.

import { marked } from "marked";
import { useCallback, useEffect, useState } from "react";
import type { FeedCard } from "../../src/types.ts";
import { Glyph, typeLabel } from "./Card.tsx";
import { apiFetch } from "./auth.ts";

marked.setOptions({ gfm: true, breaks: false });

type DraftsResponse = { drafts: FeedCard[]; total: number };

type DraftAction = "approve" | "kill" | "expand";

const ACTION_PATH: Record<DraftAction, string> = {
  approve: "approve",
  kill: "kill",
  expand: "expand",
};

const ACTION_LABEL: Record<DraftAction, string> = {
  approve: "Approve",
  kill: "Kill",
  expand: "Expand",
};

const ACTION_GLYPH: Record<DraftAction, "already_knew" | "less" | "promote"> = {
  approve: "already_knew", // checkmark
  kill: "less",
  expand: "promote",
};

function md(text: string): string {
  return marked.parse(text, { async: false });
}

function DraftCard({
  draft,
  onResolve,
}: {
  draft: FeedCard;
  /** Called when a draft leaves the tray (approved or killed). */
  onResolve: (id: string) => void;
}) {
  const [busy, setBusy] = useState<DraftAction | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async (action: DraftAction) => {
      if (busy) return;
      setBusy(action);
      setError(null);
      try {
        const res = await apiFetch(
          `/api/drafts/${encodeURIComponent(draft.id)}/${ACTION_PATH[action]}`,
          { method: "POST" },
        );
        if (!res.ok) throw new Error(`api ${res.status}`);
        if (action === "expand") {
          // Stays in the tray — just confirm the signal was recorded.
          setFlash("▸ Queued for a deeper artifact");
          setBusy(null);
          return;
        }
        // approve / kill remove the draft from the tray.
        setFlash(action === "approve" ? "✓ Approved — now in the feed" : "✓ Killed");
        window.setTimeout(() => onResolve(draft.id), 500);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
      }
    },
    [busy, draft.id, onResolve],
  );

  return (
    <article className="card draft">
      <div className="kicker">
        <span className="draft-badge">{typeLabel(draft.type)}</span>
        {draft.audience && (
          <>
            <span className="kicker-dot" aria-hidden="true" />
            <span>{draft.audience}</span>
          </>
        )}
        {draft.platform && (
          <>
            <span className="kicker-dot" aria-hidden="true" />
            <span>{draft.platform}</span>
          </>
        )}
        <span className="kicker-dot" aria-hidden="true" />
        <span className="draft-pending">pending approval</span>
      </div>

      <h2 className="headline draft-headline">{draft.headline}</h2>

      {draft.quote && (
        <blockquote className="pull">
          <p>&ldquo;{draft.quote}&rdquo;</p>
          {draft.attribution && <cite>{draft.attribution}</cite>}
        </blockquote>
      )}
      {draft.body && (
        <div className="card-body" dangerouslySetInnerHTML={{ __html: md(draft.body) }} />
      )}

      <div className="fb">
        <div className="fb-row draft-actions" role="group" aria-label="Draft actions">
          {(["approve", "expand", "kill"] as DraftAction[]).map((action) => (
            <button
              key={action}
              type="button"
              className={`fb-action draft-action draft-action-${action}`}
              disabled={busy !== null}
              title={ACTION_LABEL[action]}
              onClick={() => void act(action)}
            >
              <Glyph name={ACTION_GLYPH[action]} size={17} />
              <span>{ACTION_LABEL[action]}</span>
            </button>
          ))}
        </div>
        <div aria-live="polite">
          {flash && <div className="fb-status">{flash}</div>}
          {error && <div className="fb-status error">Action failed ({error})</div>}
        </div>
      </div>
    </article>
  );
}

export function DraftsPanel() {
  const [drafts, setDrafts] = useState<FeedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/drafts");
      if (!res.ok) throw new Error(`api ${res.status}`);
      const data = (await res.json()) as DraftsResponse;
      setDrafts(data.drafts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onResolve = useCallback((id: string) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }, []);

  return (
    <div className="drafts">
      <header className="drafts-head">
        <h1 className="drafts-title">Approvals</h1>
        <p className="drafts-sub">
          {loading ? "Loading…" : `${drafts.length} draft${drafts.length === 1 ? "" : "s"} pending`}
        </p>
      </header>

      {error && <div className="feed-error">{error}</div>}

      {!loading && drafts.length === 0 && !error ? (
        <div className="feed-status">
          <p className="feed-status-line">No drafts pending.</p>
          <p className="feed-status-sub">
            Outward drafts (social posts, investor snippets) land here for approval.
          </p>
        </div>
      ) : (
        <main className="feed">
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} onResolve={onResolve} />
          ))}
        </main>
      )}
    </div>
  );
}
