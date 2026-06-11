import { marked } from "marked";
import { useState } from "react";
import type { FeedbackAction, FeedCard } from "../../src/types.ts";

marked.setOptions({ gfm: true, breaks: false });

/** 2-letter type codes, pulse-radio style. Unknown types get initials. */
export function typeCode(type: string): string {
  const known: Record<string, string> = {
    "insight-card": "IC",
    article: "AR",
    podcast: "PC",
  };
  const k = known[type];
  if (k) return k;
  const parts = type.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return type.slice(0, 2).toUpperCase() || "??";
}

export function cardHref(card: FeedCard): string {
  return `#/a/${encodeURIComponent(card.type)}/${encodeURIComponent(card.slug)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function md(text: string): string {
  return marked.parse(text, { async: false });
}

/** First markdown paragraph, for article excerpts on the card face. */
function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/).find((p) => p.trim()) ?? text;
}

function Body({ text }: { text: string }) {
  return <div className="card-body" dangerouslySetInnerHTML={{ __html: md(text) }} />;
}

function AudioPlayer({ src }: { src: string }) {
  return (
    <div className="card-audio">
      <div className="card-audio-label">&#9654; EPISODE.PLAY</div>
      <audio controls preload="metadata" src={src} />
    </div>
  );
}

function QuoteBlock({ card }: { card: FeedCard }) {
  if (!card.quote) return null;
  return (
    <>
      <blockquote className="card-quote">&ldquo;{card.quote}&rdquo;</blockquote>
      {card.attribution && (
        <div className="card-attribution">-- {card.attribution.toUpperCase()}</div>
      )}
    </>
  );
}

function Tags({
  card,
  activeTag,
  onTagFilter,
}: {
  card: FeedCard;
  activeTag: string | null;
  onTagFilter: (tag: string | null) => void;
}) {
  if (card.tags.length === 0) return null;
  return (
    <div className="card-tags">
      {card.tags.map((t) => {
        const active = activeTag === t;
        return (
          <button
            key={t}
            type="button"
            className={`card-tag${active ? " active" : ""}`}
            onClick={() => onTagFilter(active ? null : t)}
          >
            [{t.toUpperCase()}]
          </button>
        );
      })}
    </div>
  );
}

/* ---- feedback: six actions, each teaching one unambiguous lesson ----
   more         positive + generalize          (one-tap)
   less         negative + generalize          (optional note; hides card)
   save         utility                        (one-tap)
   already_knew novelty calibration            (one-tap)
   wrong        accuracy challenge             (optional note)
   promote      commission a deeper artifact   (one-tap; queued confirmation) */

const FB_LABELS: Record<FeedbackAction, string> = {
  more: "+MORE",
  less: "-LESS",
  save: "SAVE",
  already_knew: "KNEW",
  wrong: "WRONG",
  promote: "PROMOTE",
};

const FB_CONFIRM: Record<FeedbackAction, string> = {
  more: "✓ MORE LIKE THIS",
  less: "✓ LESS — REMOVED",
  save: "✓ SAVED",
  already_knew: "✓ NOVELTY NOTED",
  wrong: "✓ FLAGGED WRONG",
  promote: "▸ QUEUED FOR DEEPER ARTIFACT",
};

/** Actions that prompt for an optional free-text note before sending. */
const FB_NOTED: ReadonlySet<FeedbackAction> = new Set(["less", "wrong"]);

type FbState =
  | { kind: "idle" }
  | { kind: "noting"; action: FeedbackAction }
  | { kind: "sending"; action: FeedbackAction }
  | { kind: "sent"; action: FeedbackAction };

export function FeedbackBar({
  card,
  onHide,
}: {
  card: FeedCard;
  onHide?: (id: string) => void;
}) {
  const [state, setState] = useState<FbState>({ kind: "idle" });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = async (action: FeedbackAction, noteText?: string) => {
    setState({ kind: "sending", action });
    setError(null);
    try {
      const body: Record<string, string> = { artifact_id: card.id, action };
      if (noteText?.trim()) body.note = noteText.trim();
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`api ${res.status}`);
      setNote("");
      setState({ kind: "sent", action });
      if (action === "less") onHide?.(card.id); // hide immediately client-side
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState({ kind: "idle" });
    }
  };

  const tap = (action: FeedbackAction) => {
    if (state.kind === "sending") return;
    if (FB_NOTED.has(action)) {
      setNote("");
      setState({ kind: "noting", action });
    } else {
      void send(action);
    }
  };

  if (state.kind === "noting") {
    const action = state.action;
    return (
      <div className="fb">
        <div className="fb-note">
          <span className="fb-note-label">{FB_LABELS[action]}?</span>
          <input
            type="text"
            value={note}
            placeholder="optional note…"
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send(action, note);
              if (e.key === "Escape") setState({ kind: "idle" });
            }}
          />
          <button type="button" className="fb-btn accent" onClick={() => void send(action, note)}>
            SEND
          </button>
          <button type="button" className="fb-btn" onClick={() => setState({ kind: "idle" })}>
            ESC
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fb">
      <div className="fb-row">
        {(Object.keys(FB_LABELS) as FeedbackAction[]).map((action) => (
          <button
            key={action}
            type="button"
            className={`fb-btn${state.kind === "sent" && state.action === action ? " sent" : ""}`}
            disabled={state.kind === "sending"}
            title={action.replace("_", " ")}
            onClick={() => tap(action)}
          >
            {FB_LABELS[action]}
          </button>
        ))}
      </div>
      {state.kind === "sent" && <div className="fb-status">{FB_CONFIRM[state.action]}</div>}
      {error && <div className="fb-status error">! FEEDBACK FAILED ({error})</div>}
    </div>
  );
}

function Foot({ card }: { card: FeedCard }) {
  const q = card.quality;
  return (
    <div className="card-foot">
      <span>
        {q ? (
          <>
            {q.critic_pass ? "✓" : "✗"}CRITIC {q.quotes_verified ? "✓" : "✗"}
            QUOTES
          </>
        ) : (
          "UNGRADED"
        )}
      </span>
      <span>{card.generation_model?.toUpperCase() ?? ""}</span>
    </div>
  );
}

export function Card({
  card,
  idx,
  activeTag,
  onTagFilter,
  onHide,
}: {
  card: FeedCard;
  idx: number;
  activeTag: string | null;
  onTagFilter: (tag: string | null) => void;
  onHide?: (id: string) => void;
}) {
  const isArticle = card.type === "article";
  const body = card.body
    ? isArticle
      ? firstParagraph(card.body)
      : card.body
    : undefined;

  return (
    <article className="chassis">
      {card.hero_image_url && (
        <div className="card-hero">
          <div className="card-hero-frame">
            <img
              src={card.hero_image_url}
              alt=""
              loading="lazy"
              decoding="async"
              onError={(e) => {
                const wrap = e.currentTarget.closest(".card-hero") as HTMLElement | null;
                if (wrap) wrap.style.display = "none";
              }}
            />
          </div>
        </div>
      )}
      <div className="screen">
        <div className="card-meta">
          <span>
            <span className="dot">&#9679;</span> A{String(idx).padStart(2, "0")}.
            {typeCode(card.type)}
          </span>
          <span>{fmtDate(card.generated_at).toUpperCase()}</span>
        </div>

        <h2 className="card-headline">
          {isArticle ? <a href={cardHref(card)}>{card.headline}</a> : card.headline}
        </h2>

        <QuoteBlock card={card} />
        {body && <Body text={body} />}
        {isArticle && card.body && (
          <a className="read-full" href={cardHref(card)}>
            &gt;&gt; READ FULL ARTICLE
          </a>
        )}
        {card.audio_url && <AudioPlayer src={card.audio_url} />}
        <Tags card={card} activeTag={activeTag} onTagFilter={onTagFilter} />
        <FeedbackBar card={card} onHide={onHide} />
        <Foot card={card} />
      </div>
    </article>
  );
}

/** Full-page view for an article (or any card opened directly). */
export function FullCard({
  card,
  onHide,
}: {
  card: FeedCard;
  /** "less" semantics: remove from feed. The article view hides + returns. */
  onHide?: (id: string) => void;
}) {
  return (
    <article className="chassis article">
      {card.hero_image_url && (
        <div className="card-hero">
          <div className="card-hero-frame">
            <img src={card.hero_image_url} alt="" decoding="async" />
          </div>
        </div>
      )}
      <div className="screen">
        <div className="card-meta">
          <span>
            <span className="dot">&#9679;</span> {typeCode(card.type)}.FULL
          </span>
          <span>{fmtDate(card.generated_at).toUpperCase()}</span>
        </div>
        <h1 className="card-headline" style={{ fontSize: 17 }}>
          {card.headline}
        </h1>
        <QuoteBlock card={card} />
        {card.body && <Body text={card.body} />}
        {card.audio_url && <AudioPlayer src={card.audio_url} />}
        {card.tags.length > 0 && (
          <div className="card-tags">
            {card.tags.map((t) => (
              <span key={t} className="card-tag">
                [{t.toUpperCase()}]
              </span>
            ))}
          </div>
        )}
        <FeedbackBar card={card} onHide={onHide} />
        <Foot card={card} />
      </div>
    </article>
  );
}
