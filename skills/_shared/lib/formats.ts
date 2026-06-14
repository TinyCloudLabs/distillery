// formats.ts — the FORMAT REGISTRY: the single source of truth for which
// artifact formats exist and how each one behaves. Everything that needs a
// format list derives it from here — the artifact contract (validation), the
// harness's outward/internal routing, the exploration slot's eligible-format
// list, the brief's miner roster, and the feed UI's kicker labels. Adding a
// format means adding ONE entry here (plus its skill); nothing else should
// need a hand-maintained list.
//
// BROWSER-SAFE ON PURPOSE: the feed's web bundle imports this file for
// labels, so it must stay pure data — no node builtins, no imports. The
// fs-bound artifact helpers live in artifact.ts, which re-exports this
// registry for script-side consumers.

export const ARTIFACT_TYPES = [
  "insight-card",
  "article",
  "podcast",
  // Multi-thread roundup: shorter than an article (~300-500 words), weaves
  // 2-3 related threads from across the corpus. Internal — always publishes.
  "digest",
  // Phase-2 outward-facing comms types. These default to approval_status
  // "pending" (see validateArtifact) — nothing outward-facing auto-publishes.
  "social-post",
  "investor-update-snippet",
  "quote-card",
  "person-brief",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/**
 * The three render SHAPES the viewer draws. Decoupled from `type` (8 formats):
 * adding a 9th format never touches the viewer; relayouting a card never
 * touches the producer. tweet = short text (+ optional quote); article =
 * headline + hero + body_md (+ optional audio); video = external embed.
 * (V1 viewer ships tweet + article; video lands later with zero churn.)
 */
export type RenderType = "tweet" | "article" | "video";

export interface FormatMeta {
  /** Human kicker label the feed UI shows. */
  label: string;
  /**
   * The viewer card shape this format publishes as (§4.2). One pure mapping:
   * publish precomputes `render_type = renderTypeFor(type)`.
   */
  render: RenderType;
  /**
   * Outward-facing formats gate at a human-approval step before they can
   * ship; internal formats always publish. (person-brief is the straddler:
   * outward-typed for the approval gate, but its audience stamp is
   * "internal" so approved briefs publish to the feed and count the cap.)
   */
  outward: boolean;
  /**
   * The skill that produces this format on the feed-run's main generation
   * path, or null when production is triggered elsewhere (person-brief: the
   * salience detector, not the per-run miner roster).
   */
  miner: string | null;
  /**
   * Eligible for the harness's format-exploration slot — the internal feed
   * miner formats. person-brief publishes internally but is salience-
   * triggered, so the slot never nudges it.
   */
  explorable: boolean;
}

export const FORMAT_REGISTRY = {
  "insight-card": { label: "Insight", outward: false, miner: "extract-insights", explorable: true, render: "article" },
  article: { label: "Article", outward: false, miner: "write-article", explorable: true, render: "article" },
  podcast: { label: "Podcast", outward: false, miner: "make-podcast", explorable: true, render: "article" },
  digest: { label: "Digest", outward: false, miner: "write-digest", explorable: true, render: "article" },
  "social-post": { label: "Social post", outward: true, miner: "banger-extractor", explorable: false, render: "tweet" },
  "investor-update-snippet": { label: "Investor snippet", outward: true, miner: "investor-snippet", explorable: false, render: "tweet" },
  "quote-card": { label: "Quote card", outward: true, miner: "quote-card", explorable: false, render: "tweet" },
  "person-brief": { label: "Person brief", outward: true, miner: null, explorable: false, render: "article" },
} as const satisfies Record<ArtifactType, FormatMeta>;

/**
 * Publish-time pure mapping from a distillery `type` (8-value, canonical) to a
 * viewer `render_type` (3-value). The ONLY place this mapping lives (§4.2);
 * tc-publish precomputes it into the stored `render_type` column.
 */
export function renderTypeFor(type: ArtifactType): RenderType {
  return FORMAT_REGISTRY[type].render;
}

/** Outward-facing types gate at a human-approval step before they can ship. */
export const OUTWARD_ARTIFACT_TYPES: readonly ArtifactType[] = ARTIFACT_TYPES.filter(
  (t) => FORMAT_REGISTRY[t].outward,
);

export function isOutwardType(type: ArtifactType): boolean {
  return FORMAT_REGISTRY[type].outward;
}

/** The formats the exploration slot may nudge, as a literal union. */
export type ExplorableFormat = {
  [K in ArtifactType]: (typeof FORMAT_REGISTRY)[K]["explorable"] extends true ? K : never;
}[ArtifactType];

export const EXPLORABLE_FORMATS: readonly ExplorableFormat[] = ARTIFACT_TYPES.filter(
  (t): t is ExplorableFormat => FORMAT_REGISTRY[t].explorable,
);
