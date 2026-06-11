import { marked } from "marked";
import { useCallback, useRef, useState, type ReactNode } from "react";
import type { FeedbackAction, FeedCard } from "../../src/types.ts";

marked.setOptions({ gfm: true, breaks: false });

/** Human type label for the kicker. Unknown types get prettified words. */
export function typeLabel(type: string): string {
  const known: Record<string, string> = {
    "insight-card": "Insight",
    article: "Article",
    podcast: "Podcast",
  };
  const k = known[type];
  if (k) return k;
  const words = type.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return "Artifact";
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

export function cardHref(card: FeedCard): string {
  return `#/a/${encodeURIComponent(card.type)}/${encodeURIComponent(card.slug)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** `[novelty] lead=<type>: ...` in quality.notes → "quantified drift". */
export function noveltyLead(card: FeedCard): string | null {
  const notes = card.quality?.notes;
  if (!notes) return null;
  const m = /\[novelty\]\s*lead=([a-z0-9-]+)/i.exec(notes);
  if (!m) return null;
  return m[1]!.replace(/-/g, " ");
}

function md(text: string): string {
  return marked.parse(text, { async: false });
}

/** First markdown paragraph, for article excerpts on the card face. */
function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/).find((p) => p.trim()) ?? text;
}

/* ---- glyphs: 1.6px-stroke outline icons in currentColor ---- */

type GlyphName = FeedbackAction | "play" | "pause" | "sliders" | "arrow" | "back";

export function Glyph({ name, size = 17 }: { name: GlyphName; size?: number }) {
  const paths: Record<GlyphName, ReactNode> = {
    more: <path d="M12 5v14M5 12h14" />,
    less: <path d="M5 12h14" />,
    save: <path d="M6 4h12v17l-6-4.5L6 21V4z" />,
    already_knew: <path d="M4 12.5l5.5 5.5L20 6.5" />,
    wrong: <path d="M6 6l12 12M18 6L6 18" />,
    promote: <path d="M7 17L17 7M9 7h8v8" />,
    play: <path d="M8 5.5v13l11-6.5L8 5.5z" fill="currentColor" stroke="none" />,
    pause: <path d="M8 5.5v13M16 5.5v13" strokeWidth="2.4" />,
    sliders: <path d="M4 7h10M18 7h2M16 4.8v4.4M4 17h2M10 17h10M8 14.8v4.4" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

/* ---- kicker: TYPE · DATE · N TRANSCRIPTS · novelty ---- */

function Kicker({ card }: { card: FeedCard }) {
  const novelty = noveltyLead(card);
  const sources = card.source_transcripts.length;
  return (
    <div className="kicker">
      <span className="kicker-type">{typeLabel(card.type)}</span>
      <span className="kicker-dot" aria-hidden="true" />
      <span>{fmtDate(card.generated_at)}</span>
      {sources > 0 && (
        <>
          <span className="kicker-dot" aria-hidden="true" />
          <span>
            {sources} transcript{sources === 1 ? "" : "s"}
          </span>
        </>
      )}
      {novelty && (
        <span className="novelty">
          <span className="novelty-pip" aria-hidden="true" />
          Novel · {novelty} lead
        </span>
      )}
    </div>
  );
}

function Body({ text }: { text: string }) {
  return <div className="card-body" dangerouslySetInnerHTML={{ __html: md(text) }} />;
}

/* ---- audio: circular play + hairline scrubber + mono timestamps ---- */

function AudioRow({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }, []);

  const seek = useCallback((fraction: number) => {
    const el = ref.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(1, fraction)) * el.duration;
  }, []);

  const progress = duration > 0 ? time / duration : 0;

  return (
    <div className="audio">
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          setTime(e.currentTarget.currentTime);
          // loadedmetadata can fire before listeners attach (cached media) —
          // recover the duration here too.
          if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
        }}
      />
      <button
        type="button"
        className="audio-play"
        aria-label={playing ? "Pause episode" : "Play episode"}
        onClick={toggle}
      >
        <Glyph name={playing ? "pause" : "play"} size={18} />
      </button>
      <div className="audio-track">
        <input
          type="range"
          className="audio-range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          aria-label="Seek"
          onChange={(e) => seek(Number(e.target.value) / 1000)}
        />
        <div className="audio-times">
          <span>{fmtTime(time)}</span>
          <span>{duration ? fmtTime(duration) : "—:—"}</span>
        </div>
      </div>
    </div>
  );
}

/* ---- pull quote: red left rule, serif italic, mono cite ---- */

function QuoteBlock({ card }: { card: FeedCard }) {
  if (!card.quote) return null;
  return (
    <blockquote className="pull">
      <p>&ldquo;{card.quote}&rdquo;</p>
      {card.attribution && <cite>{card.attribution}</cite>}
    </blockquote>
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
    <div className="tags">
      {card.tags.map((t) => {
        const active = activeTag === t;
        return (
          <button
            key={t}
            type="button"
            className={`tag${active ? " active" : ""}`}
            aria-pressed={active}
            onClick={() => onTagFilter(active ? null : t)}
          >
            {t}
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
  more: "More",
  less: "Less",
  save: "Save",
  already_knew: "Knew it",
  wrong: "Wrong",
  promote: "Promote",
};

const FB_CONFIRM: Record<FeedbackAction, string> = {
  more: "✓ More like this",
  less: "✓ Less — removed from feed",
  save: "✓ Saved",
  already_knew: "✓ Novelty noted",
  wrong: "✓ Flagged wrong",
  promote: "▸ Queued for deeper artifact",
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
          <span className="fb-note-label">{FB_LABELS[action]}</span>
          <input
            type="text"
            value={note}
            placeholder="optional note…"
            aria-label={`Optional note for ${FB_LABELS[action]}`}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send(action, note);
              if (e.key === "Escape") setState({ kind: "idle" });
            }}
          />
          <button type="button" className="quiet-link" onClick={() => void send(action, note)}>
            Send
          </button>
          <button type="button" className="quiet-link" onClick={() => setState({ kind: "idle" })}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fb">
      <div className="fb-row" role="group" aria-label="Feedback">
        {(Object.keys(FB_LABELS) as FeedbackAction[]).map((action) => {
          const on = state.kind === "sent" && state.action === action;
          return (
            <button
              key={action}
              type="button"
              className={`fb-action${on ? " is-on" : ""}`}
              aria-pressed={on}
              disabled={state.kind === "sending"}
              title={action.replace("_", " ")}
              onClick={() => tap(action)}
            >
              <Glyph name={action} size={17} />
              <span>{FB_LABELS[action]}</span>
            </button>
          );
        })}
      </div>
      <div aria-live="polite">
        {state.kind === "sent" && <div className="fb-status">{FB_CONFIRM[state.action]}</div>}
        {error && <div className="fb-status error">Feedback failed ({error})</div>}
      </div>
    </div>
  );
}

/* ---- provenance microline ---- */

function Foot({ card }: { card: FeedCard }) {
  const q = card.quality;
  return (
    <div className="card-foot">
      <span>
        {q ? (
          <>
            {q.critic_pass ? "✓" : "✗"} critic · {q.quotes_verified ? "✓" : "✗"} quotes
          </>
        ) : (
          "ungraded"
        )}
      </span>
      <span>{card.generation_model ?? ""}</span>
    </div>
  );
}

export function Card({
  card,
  activeTag,
  onTagFilter,
  onHide,
}: {
  card: FeedCard;
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
    <article className="card">
      <Kicker card={card} />
      <h2 className="headline">
        {isArticle ? <a href={cardHref(card)}>{card.headline}</a> : card.headline}
      </h2>
      {card.hero_image_url && (
        <figure className="hero">
          <img
            src={card.hero_image_url}
            alt=""
            loading="lazy"
            decoding="async"
            onError={(e) => {
              const wrap = e.currentTarget.closest(".hero") as HTMLElement | null;
              if (wrap) wrap.style.display = "none";
            }}
          />
        </figure>
      )}
      <QuoteBlock card={card} />
      {body && <Body text={body} />}
      {isArticle && card.body && (
        <a className="quiet-link read-link" href={cardHref(card)}>
          Continue reading <Glyph name="arrow" size={14} />
        </a>
      )}
      {card.audio_url && <AudioRow src={card.audio_url} />}
      <Tags card={card} activeTag={activeTag} onTagFilter={onTagFilter} />
      <FeedbackBar card={card} onHide={onHide} />
      <Foot card={card} />
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
    <article className="card article">
      <Kicker card={card} />
      <h1 className="headline">{card.headline}</h1>
      {card.hero_image_url && (
        <figure className="hero">
          <img src={card.hero_image_url} alt="" decoding="async" />
        </figure>
      )}
      <QuoteBlock card={card} />
      {card.body && <Body text={card.body} />}
      {card.audio_url && <AudioRow src={card.audio_url} />}
      {card.tags.length > 0 && (
        <div className="tags">
          {card.tags.map((t) => (
            <span key={t} className="tag" role="presentation">
              {t}
            </span>
          ))}
        </div>
      )}
      <FeedbackBar card={card} onHide={onHide} />
      <Foot card={card} />
    </article>
  );
}
