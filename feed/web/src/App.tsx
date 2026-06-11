import { useCallback, useEffect, useRef, useState } from "react";
import type { CardsResponse, FeedCard } from "../../src/types.ts";
import { Card, FullCard, Glyph } from "./Card.tsx";
import { PreferencesPanel } from "./Preferences.tsx";

const PAGE_SIZE = 20;
const UNDO_MS = 8000;

type Route =
  | { kind: "feed" }
  | { kind: "article"; type: string; slug: string }
  | { kind: "prefs" };

function parseRoute(hash: string): Route {
  if (hash === "#/preferences") return { kind: "prefs" };
  const m = /^#\/a\/([^/]+)\/([^/]+)$/.exec(hash);
  if (m) {
    return {
      kind: "article",
      type: decodeURIComponent(m[1]!),
      slug: decodeURIComponent(m[2]!),
    };
  }
  return { kind: "feed" };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  // Cards dismissed via the "less" feedback action — hidden immediately,
  // session-only (the distill-preferences loop handles durable effects).
  // Lives here, not in Feed, so a hide survives feed ⇄ article navigation
  // (Feed unmounts while an article is open).
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // Last hide gets an undo affordance (DESIGN_PLAN: "less" must offer undo).
  // Undo restores visibility client-side; the feedback event stays logged.
  const [undo, setUndo] = useState<{ id: string } | null>(null);
  const undoTimer = useRef<number | null>(null);

  const hideCard = useCallback((id: string) => {
    setHidden((prev) => new Set(prev).add(id));
    setUndo({ id });
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
  }, []);

  // The auto-dismiss must not race keyboard/SR users tabbing toward the Undo
  // button: pause the timer while the toast (or anything in it) has hover or
  // focus, restart the full window when it leaves.
  const pauseUndoTimer = useCallback(() => {
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
  }, []);

  const resumeUndoTimer = useCallback(() => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
  }, []);

  const undoHide = useCallback(() => {
    setUndo((u) => {
      if (u) {
        setHidden((prev) => {
          const next = new Set(prev);
          next.delete(u.id);
          return next;
        });
      }
      return null;
    });
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
  }, []);

  return (
    <>
      {route.kind === "article" ? (
        <ArticleView type={route.type} slug={route.slug} onHide={hideCard} />
      ) : route.kind === "prefs" ? (
        <PrefsView />
      ) : (
        <Feed hidden={hidden} onHide={hideCard} />
      )}
      <div role="status" aria-live="polite">
        {undo && (
          <div
            className="undo-toast"
            onMouseEnter={pauseUndoTimer}
            onMouseLeave={resumeUndoTimer}
            onFocus={pauseUndoTimer}
            onBlur={resumeUndoTimer}
          >
            <span className="undo-toast-text">Removed from feed</span>
            <button type="button" className="quiet-link" onClick={undoHide}>
              Undo
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skel-card">
          <div className="skel-bar kicker" />
          <div className="skel-bar headline" />
          <div className="skel-bar headline2" />
          <div className="skel-bar body" />
          <div className="skel-bar body2" />
          <div className="skel-bar body3" />
        </div>
      ))}
    </div>
  );
}

function edition(cards: FeedCard[]): string {
  const newest = cards[0]?.generated_at;
  if (!newest) return "";
  const d = new Date(newest);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `Edition ${mm}.${dd} — `;
}

function Feed({
  hidden,
  onHide,
}: {
  hidden: ReadonlySet<string>;
  onHide: (id: string) => void;
}) {
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const fetchPage = useCallback(async (offset: number) => {
    const res = await fetch(`/api/cards?limit=${PAGE_SIZE}&offset=${offset}`);
    if (!res.ok) throw new Error(`api ${res.status}`);
    return (await res.json()) as CardsResponse;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPage(0);
      setCards(data.cards);
      setTotal(data.total);
      setHasMore(data.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const data = await fetchPage(cards.length);
      setCards((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...data.cards.filter((c) => !seen.has(c.id))];
      });
      setTotal(data.total);
      setHasMore(data.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [cards.length, fetchPage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || loadingMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loading, loadingMore, loadMore]);

  const visible = cards.filter(
    (c) => !hidden.has(c.id) && (!activeTag || c.tags.includes(activeTag)),
  );

  return (
    <>
      <header className="masthead">
        <div>
          <h1 className="masthead-title">Distillery</h1>
          <p className="masthead-sub">
            {edition(cards)}
            {visible.length}/{total} artifacts
          </p>
          {activeTag && (
            <button
              type="button"
              className="mono-chip"
              onClick={() => setActiveTag(null)}
              aria-label={`Clear tag filter ${activeTag}`}
            >
              tag: {activeTag} ✕
            </button>
          )}
        </div>
        <nav className="masthead-nav" aria-label="Feed controls">
          <a className="quiet-link" href="#/preferences">
            <Glyph name="sliders" size={14} /> Preferences
          </a>
          <button
            type="button"
            className="quiet-link"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? "Scanning…" : "Rescan"}
          </button>
        </nav>
      </header>

      {error && <div className="feed-error">{error}</div>}

      <main className="feed">
        {loading ? (
          <>
            <p className="sr-only" role="status">
              Loading feed
            </p>
            <Skeleton />
          </>
        ) : visible.length === 0 ? (
          <div className="feed-status">
            <p className="feed-status-line">Nothing new yet.</p>
            <p className="feed-status-sub">
              {activeTag ? "No artifacts for this tag" : "Run a distill skill, then rescan"}
            </p>
            <button type="button" className="quiet-link" onClick={() => void refresh()}>
              Rescan
            </button>
          </div>
        ) : (
          visible.map((c) => (
            <Card
              key={c.id}
              card={c}
              activeTag={activeTag}
              onTagFilter={setActiveTag}
              onHide={onHide}
            />
          ))
        )}
        {hasMore && !activeTag && <div ref={sentinelRef} style={{ height: 1 }} />}
        {loadingMore && (
          <p className="feed-status-sub" style={{ textAlign: "center", padding: "16px 0" }}>
            Loading…
          </p>
        )}
      </main>
    </>
  );
}

function BackBar() {
  return (
    <div className="article-bar">
      <a className="quiet-link" href="#/">
        <Glyph name="back" size={14} /> Back to feed
      </a>
    </div>
  );
}

function PrefsView() {
  return (
    <>
      <BackBar />
      <main>
        <PreferencesPanel />
      </main>
    </>
  );
}

function ArticleView({
  type,
  slug,
  onHide,
}: {
  type: string;
  slug: string;
  onHide: (id: string) => void;
}) {
  const [card, setCard] = useState<FeedCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  // "less" removes the card from the feed — honor that here too: record the
  // hide, let the "✓ Less — removed" confirmation flash, then return to the
  // feed (where the card is now gone).
  const hideAndReturn = useCallback(
    (id: string) => {
      onHide(id);
      window.setTimeout(() => {
        location.hash = "#/";
      }, 600);
    },
    [onHide],
  );

  useEffect(() => {
    let alive = true;
    setCard(null);
    setError(null);
    fetch(`/api/cards/${encodeURIComponent(type)}/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "artifact not found" : `api ${res.status}`);
        return (await res.json()) as FeedCard;
      })
      .then((c) => {
        if (alive) setCard(c);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [type, slug]);

  return (
    <>
      <BackBar />
      {error && (
        <div className="feed-status">
          <p className="feed-status-line">Couldn&rsquo;t open this artifact.</p>
          <p className="feed-status-sub">{error}</p>
        </div>
      )}
      {!card && !error && (
        <p className="sr-only" role="status">
          Loading article
        </p>
      )}
      {!card && !error && (
        <div className="skel-card" aria-hidden="true" style={{ borderBottom: "none" }}>
          <div className="skel-bar kicker" />
          <div className="skel-bar headline" />
          <div className="skel-bar headline2" />
          <div className="skel-bar body" />
          <div className="skel-bar body2" />
          <div className="skel-bar body3" />
        </div>
      )}
      {card && (
        <main>
          <FullCard card={card} onHide={hideAndReturn} />
        </main>
      )}
    </>
  );
}
