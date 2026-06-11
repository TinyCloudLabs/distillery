import { useCallback, useEffect, useRef, useState } from "react";
import type { CardsResponse, FeedCard } from "../../src/types.ts";
import { Card, FullCard } from "./Card.tsx";

const PAGE_SIZE = 20;

type Route = { kind: "feed" } | { kind: "article"; type: string; slug: string };

function parseRoute(hash: string): Route {
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
  const hideCard = useCallback((id: string) => {
    setHidden((prev) => new Set(prev).add(id));
  }, []);

  if (route.kind === "article") {
    return <ArticleView type={route.type} slug={route.slug} onHide={hideCard} />;
  }
  return <Feed hidden={hidden} onHide={hideCard} />;
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
      <header className="masthead chassis">
        <div className="screen">
          <div>
            <div className="masthead-title">DISTILLERY</div>
            <div className="masthead-sub">
              FEED V1 &middot; {visible.length}/{total} ARTIFACTS
            </div>
            {activeTag && (
              <button
                type="button"
                className="card-tag active"
                style={{ marginTop: 4 }}
                onClick={() => setActiveTag(null)}
              >
                [TAG:{activeTag.toUpperCase()}&times;]
              </button>
            )}
          </div>
          <div className="masthead-right">
            <span>&#9646;&#9646;&#9646;&#9646;&#9647; BAT</span>
            <button
              type="button"
              className="po-btn"
              style={{ padding: "4px 8px", fontSize: 9 }}
              disabled={loading}
              onClick={() => void refresh()}
            >
              {loading ? "SCAN…" : "▶ RESCAN"}
            </button>
          </div>
        </div>
      </header>

      {error && <div className="feed-error">! {error}</div>}

      <main className="feed">
        {loading ? (
          <div className="feed-status">-- SCANNING ARTIFACTS --</div>
        ) : visible.length === 0 ? (
          <div className="feed-status">
            -- NO ARTIFACTS{activeTag ? " FOR TAG" : " — RUN A DISTILL SKILL"} --
          </div>
        ) : (
          visible.map((c, i) => (
            <Card
              key={c.id}
              card={c}
              idx={i + 1}
              activeTag={activeTag}
              onTagFilter={setActiveTag}
              onHide={onHide}
            />
          ))
        )}
        {hasMore && !activeTag && <div ref={sentinelRef} style={{ height: 1 }} />}
        {loadingMore && <div className="feed-status">-- LOADING --</div>}
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
  // hide, let the "✓ LESS — REMOVED" confirmation flash, then return to the
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
      <a className="article-back" href="#/">
        &lt;&lt; BACK TO FEED
      </a>
      {error && <div className="feed-error">! {error}</div>}
      {!card && !error && <div className="feed-status">-- LOADING --</div>}
      {card && <FullCard card={card} onHide={hideAndReturn} />}
    </>
  );
}
