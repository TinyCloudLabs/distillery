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

## Prerequisites

- bun installed. No API key required.

## Procedure

Run all commands from the distillery repo root.

### 1. Summarize the event log (script)

```sh
bun skills/distill-preferences/scripts/summarize-events.ts --format md
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
  promoted cards as a queue of commissions for deeper artifacts.
- File sections: **Topics** (subject matter), **Novelty bar**
  (`already_knew` patterns), **Formats** (artifact types, length, media),
  **Style** (voice, sourcing, structure — `wrong` patterns often land
  here), **Cadence** (volume/frequency).

### 4. Report

Tell the user what you changed and why, citing the event counts. If you
changed nothing because no signal cleared the ≥2 bar, say so — zero
updates is a valid result.
