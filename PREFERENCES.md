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

## Topics

<!-- example (not a real preference): -->
<!-- - [learned] More capability-model deep dives (2× more + 1 promote on openkey-tagged cards, Jun 2026) -->

## Novelty bar

<!-- example (not a real preference): -->
<!-- - [learned] Skip basic UCAN explainers — table stakes (2× already_knew on ucan-101 cards, Jun 2026) -->

## Formats

<!-- example (not a real preference): -->
<!-- - [learned] Micro-podcasts earn deeper artifacts (2 promote actions on podcast cards, Jun 2026) -->

## Style

<!-- example (not a real preference): -->
<!-- - [learned] Prefer quote-anchored claims over summary prose (wrong actions cluster on unquoted claims, Jun 2026) -->

## Cadence

<!-- example (not a real preference): -->
<!-- - [learned] Weekly digest volume is right; daily was noise (less actions spike on same-day duplicate topics, Jun 2026) -->
