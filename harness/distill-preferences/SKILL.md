# Skill: distill-preferences

Turn the feedback event log (`feedback/events.jsonl`) into updates to
**PREFERENCES.md** — the human-readable preferences panel the generation
skills read before producing artifacts. The **script does the deterministic
aggregation**; **you — the agent — do the judgment** of what the aggregates
mean and which `[learned]` bullets to add, update, or remove. Any agent
that can run bun can use this skill (Claude Code, Hermes, Codex, Cursor…).

## What the six actions teach

Each action on a feed card teaches exactly one lesson:

| action | lesson |
| --- | --- |
| `more` | positive + generalize — more like this (topic/format/style) |
| `less` | negative + generalize — less like this; also removed from feed |
| `save` | utility — worth keeping; says nothing about wanting more |
| `already_knew` | novelty calibration — true but below the novelty bar |
| `wrong` | accuracy challenge — a claim is disputed; check quote anchoring |
| `promote` | this card earned a commission for a deeper artifact — its topic/format earns deeper artifacts |

Any event may carry a free-text `note`; notes are the highest-signal data
in the log — always read them.

## When this runs in the feed-run loop (the ordering — MANDATORY)

In the `feed-run` recipe this skill is the generation agent's **FIRST task,
before any generation** (feed-run SKILL.md step 5a). The orchestrator's step 2
runs the deterministic aggregation (`summarize-events.ts`) and **embeds its
output in the run-brief**; the agent then does the judgment below — updating
`PREFERENCES.md`'s `[learned]` lines — and **re-reads the freshly-updated file
before generating**. This is the wire that closes the loop: reactions only
become preferences because the agent writes them here, every run, ahead of the
batch they influence. (When running this skill standalone — not inside feed-run
— just run the procedure end to end yourself.)

## Prerequisites

- bun installed. No API key required.

## Procedure

Run all commands from the distillery repo root.

### 1. Summarize the event log (script)

```sh
bun harness/distill-preferences/scripts/summarize-events.ts --format md
```

Options: `--events <path>` (default `feedback/events.jsonl`),
`--artifacts-dir <path>` (default `artifacts`), `--format json|md`
(default `json`). The artifacts dir is scanned so events are joined with
each artifact's tags and headline; aggregates come back per artifact, per
tag, and per type, plus all notes.

### 2. Read the artifacts the events point at (your judgment)

For every artifact with meaningful signal (especially `less`, `wrong`,
`promote`, or any note), open
`artifacts/<type>/<slug>/artifact.json` and read the actual content.
Aggregates say *where* the signal is; the artifact says *what* it's about.
A `wrong` on a card means re-examine the claim and its source quotes — the
lesson may be about sourcing style, not topic.

### 3. Propose PREFERENCES.md updates (your judgment)

Edit **only `[learned]` bullets** in PREFERENCES.md, respecting the
convention documented at the top of that file:

- **Never touch untagged lines** — they are human-authored and
  authoritative. Never edit, reword, reorder, or remove them. If a
  `[learned]` candidate contradicts a human line, the human line wins;
  drop the candidate (optionally note the tension in your report to the
  user, not in the file).
- **Be conservative.** Require **≥2 consistent signals** (same tag, type,
  or clearly-shared theme) before writing or strengthening a generalizing
  bullet. A single event stays instance-level — it is not a preference
  yet; leave it in the log and wait.
- Every `[learned]` bullet carries its evidence in parens:
  `- [learned] <preference> (<count>× <action> on <scope>, <month year>)`.
- **Update** an existing `[learned]` bullet when new events strengthen or
  refine it (bump the count, tighten the scope). **Remove** one when the
  evidence reverses (e.g. later `more` events on a topic previously marked
  less) — explain removals to the user.
- `promote` events also mean **"this topic/format earns deeper
  artifacts"** — reflect that under Topics and/or Formats, and treat the
  promoted cards as a queue of commissions for deeper artifacts. Write the
  `[learned]` bullet so generation backpressure can ACT on it: name the topic/
  format concretely (the keywords the selection ranker and the generation agent
  match on), e.g. `- [learned] Single-voice-thesis cards earn deeper artifacts —
  promote them into expanded pieces (3 promote …)`. PREFERENCES.md is the
  control valve that steers BOTH selection and generation, so a vague bullet
  steers nothing — make the loved/disliked subject matter explicit.
- File sections: **Topics** (subject matter), **Novelty bar**
  (`already_knew` patterns), **Formats** (artifact types, length, media),
  **Style** (voice, sourcing, structure — `wrong` patterns often land
  here), **Cadence** (volume/frequency).

### 4. Report

Tell the user what you changed and why, citing the event counts. If you
changed nothing because no signal cleared the ≥2 bar, say so — zero
updates is a valid result. **In the feed-run loop, when you make zero
changes, state it explicitly with the phrase "no change warranted"** (e.g.
"distill: no change warranted, 2 events below threshold"). The deterministic
post-run verification (`verify-distill.ts`) scans for that marker; without it,
a run with pending feedback events but no `[learned]` change is flagged
`distill_skipped=true` (the loop assumes you forgot, not that you judged).

**The phrase is NOT a magic bypass.** `verify-distill.ts` honors a "no change
warranted" claim ONLY when it re-runs the deterministic `summarize-events`
aggregate over the still-pending events and confirms NO grouping (artifact, tag,
or type) reaches the ≥2-signal bar. If a grouping DOES clear the bar and you
made no `[learned]` change, the claim is treated as a CONTRADICTED no-op and the
run is flagged `distill_skipped=true` anyway — the backlog is preserved, not
consumed. So write the phrase only when the math actually agrees; if a real
preference is distillable, write the `[learned]` bullet.

## Enforcement (deterministic — not just convention)

Two guards make the cardinal rules unbreakable in the feed-run loop; both run
after your distill, make no model calls, and you do not invoke them yourself.
**In production they run in the wrapper** (`harness/ops/launchd/feedrun.sh`), which
brackets the headless `claude -p` agent call with `snapshot → check →
verify-distill` — so the protection holds no matter how/when you write
`PREFERENCES.md` (the launchd plist and the Generate button both spawn that
wrapper). `feed-run.ts` keeps the same guard around its direct real-generation
path as defense in depth.

- **Human-line guard** (`guard-preferences.ts`): if you edit, remove, add, or
  reorder ANY non-`[learned]` line in `PREFERENCES.md`, the write is REJECTED
  and the file is RESTORED from a pre-distill snapshot. You may only touch
  `- [learned]` bullets. (Edge case: a human line that literally starts with
  `- [learned]` is, per the reserved-prefix convention, agent-owned — but
  humans never author that prefix, so this is your line to manage.)
- **Distill verification** (`verify-distill.ts`): see step 4 — make a real
  `[learned]` change, or log "no change warranted" ONLY when the aggregate
  agrees no grouping clears the ≥2-signal bar.
