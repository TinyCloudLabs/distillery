# PREFERENCES

The human-readable preferences panel for distillery's generators. Skills
read this file before generating; the distill-preferences skill updates it
from the feedback event log (`feedback/events.jsonl`).

**Convention — read before editing:**

- **Untagged lines are HUMAN-authored and authoritative.** Agents never
  edit, reword, or remove them.
- **Agent-derived lines are bullets tagged `[learned]`**, with the
  evidence that justifies them in parens — e.g.
  `- [learned] Less SPARQ-internal content (3× less on sparq-tagged cards, Jun 2026)`.
  Agents may add, update, or remove `[learned]` bullets (and only those)
  when the evidence changes.
- A human may promote a `[learned]` bullet by rewriting it as an untagged
  line; from then on it is human-authored and off-limits to agents.
- **The `- [learned]` prefix at bullet start is reserved for agent-derived
  lines** — humans must never author it (to promote a bullet, delete the
  tag). A `[learned]` mention anywhere other than the start of a bullet
  (like the ones in this preamble) is plain text, not a tagged bullet.
  This convention is now **deterministically enforced**: before every agent
  distill, a guard (`harness/distill-preferences/scripts/guard-preferences.ts`)
  snapshots every non-`[learned]` line; after the agent writes, it asserts
  that set is unchanged and **restores the file** if any human line was
  edited, removed, added, or reordered. Because the guard classifies lines by
  the reserved prefix alone, a human line that literally begins `- [learned]`
  is treated as agent-owned (mutable) — which is exactly why humans must
  never author that prefix.

## Topics

<!-- example (not a real preference): -->
<!-- - [learned] More capability-model deep dives (2× more + 1 promote on openkey-tagged cards, Jun 2026) -->
- [learned] More foundational/strategic theses on TinyCloud's positioning and why its data/credential layer matters — founding-era wedge, property-rights/credentials frame (5 more + 3 promote across the founding-wedge + eigenlayer cards, Jun 2026)

## Novelty bar

<!-- example (not a real preference): -->
<!-- - [learned] Skip basic UCAN explainers — table stakes (2× already_knew on ucan-101 cards, Jun 2026) -->

## Formats

<!-- example (not a real preference): -->
<!-- - [learned] Micro-podcasts earn deeper artifacts (2 promote actions on podcast cards, Jun 2026) -->
- [learned] Insight cards are landing — keep producing them (5 more + 4 save + 3 promote across 2 insight-cards, Jun 2026)
- [learned] Single-voice-thesis cards earn deeper artifacts — promote them into expanded pieces (3 promote on single-voice-thesis cards, Jun 2026)

## Style

<!-- example (not a real preference): -->
<!-- - [learned] Prefer quote-anchored claims over summary prose (wrong actions cluster on unquoted claims, Jun 2026) -->
- [learned] Lead with one person's strategic thesis in their own voice — a single-voice claim no one else in the corpus echoes (5 more + 4 save + 3 promote on single-voice-thesis-tagged cards, Jun 2026)

## Cadence

<!-- example (not a real preference): -->
<!-- - [learned] Weekly digest volume is right; daily was noise (less actions spike on same-day duplicate topics, Jun 2026) -->
