// routing.ts — the routing seam between the two layers.
//
// Skills STAMP `approval_status` + `audience` on each artifact; the harness
// ROUTES on those fields. This module is the single place that decides, for a
// scanned FeedCard, whether it belongs in the PUBLISHED feed or in the
// APPROVALS / DRAFTS tray.
//
// The contract (skills/_shared/lib/artifact.ts):
//   - OUTWARD types (social-post, investor-update-snippet, quote-card,
//     person-brief) are born approval_status:"pending" and must NOT publish
//     until a human approves them.
//   - INTERNAL types (insight-card, article, podcast) ignore approval_status
//     and always publish.
//
// The published feed shows: internal artifacts + outward artifacts whose
// approval_status === "approved". The drafts tray shows: outward artifacts
// whose approval_status is pending (or absent — the contract defaults absent
// outward to pending, and so do we, so nothing outward leaks unapproved).
//
// Server-only module: kept out of harness/feed/src/types.ts (which the browser bundle
// imports) so the outward-type list lives in exactly one place per layer.

import type { FeedCard } from "./types.ts";

/**
 * Outward-facing artifact types. Mirrors OUTWARD_ARTIFACT_TYPES in
 * skills/_shared/lib/artifact.ts. The scanner keeps `type` an open string
 * (the feed renders unknown future types), so we match by membership.
 */
export const OUTWARD_TYPES: ReadonlySet<string> = new Set([
  "social-post",
  "investor-update-snippet",
  "quote-card",
  "person-brief",
]);

export function isOutwardType(type: string): boolean {
  return OUTWARD_TYPES.has(type);
}

/**
 * A card's effective approval status. Outward types default to "pending" when
 * the field is absent (matching validateArtifact's default — nothing outward
 * is approved by default). Internal types never gate, so their status is
 * irrelevant and reported as "approved" for routing simplicity.
 */
export function approvalStatus(card: FeedCard): "pending" | "approved" {
  if (!isOutwardType(card.type)) return "approved";
  const raw = (card as { approval_status?: unknown }).approval_status;
  return raw === "approved" ? "approved" : "pending";
}

/**
 * Does this card belong in the PUBLISHED feed (GET /api/cards)? True for all
 * internal artifacts and for outward artifacts that have been approved.
 * Outward-pending artifacts are EXCLUDED — they live in the drafts tray.
 *
 * GATING ASYMMETRY (intentional, no leak — see PR #12 Nit). This feed gate keys
 * on TYPE (isOutwardType + approval_status), while the harness
 * partitionByRouting (harness/feed-run/scripts/run-generation-lib.ts) keys on
 * AUDIENCE (isDraftAudience). They can disagree for a MALFORMED artifact — e.g.
 * an outward type stamped audience:"internal", or an outward type with no
 * audience at all. Both gates are still correct:
 *   - The FEED is the real publish gate. It gates by type here, so an outward
 *     type without an explicit "approved" status NEVER reaches /api/cards
 *     regardless of its audience field. No unapproved outward artifact leaks.
 *   - The HARNESS partition only decides cap/dedup participation (an internal
 *     concern); it does not publish. The worst a type/audience mismatch can do
 *     there is mis-bucket an artifact for cap accounting, never publish it.
 * So there is no path by which the disagreement publishes an unapproved draft.
 */
export function isPublished(card: FeedCard): boolean {
  return approvalStatus(card) === "approved";
}

/**
 * Is this card a pending outward DRAFT (GET /api/drafts)? Only outward types
 * that are not yet approved. A "killed" draft (quarantined dir, see app.ts)
 * never reaches the scanner, so it is implicitly absent from this set.
 */
export function isPendingDraft(card: FeedCard): boolean {
  return isOutwardType(card.type) && approvalStatus(card) === "pending";
}
