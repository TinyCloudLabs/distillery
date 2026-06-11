# Skill: extract-insights

Distill meeting/conversation transcripts into **insight-card artifacts**:
surprising claims, interesting ideas, recurring topics, and asymmetric
knowledge held by specific people. Works on a single transcript or a
collection (file paths or directories — always passed in, never assumed).

This skill is the template for all distillery skills: the **scripts do
deterministic plumbing** (parsing, chunking, quote verification,
validation, persistence); **you — the agent — do the judgment** (selecting,
drafting, critiquing). Any agent that can run bun can use this skill.

## Prerequisites

- bun installed.
- No API key required — the scripts are deterministic plumbing; everything
  else is agent judgment.

## Procedure

Run all commands from the distillery repo root.

### 1. Extract — parse + chunk (scripts)

```sh
bun skills/extract-insights/scripts/extract.ts <transcript-path>... [--max-chunk 8000] [--out chunks.json]
bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... --format md [--out novelty.md]
```

Accepts .md/.txt files or directories (recursed). Emits JSON:
`{ transcripts: [{path, title, date, participants, summary?}], chunks: [{transcript, index, speakers, text}] }`.
Without `--out` it prints to stdout.

**Run the novelty scan alongside the extract — always.** It surfaces
novelty CANDIDATES you judge in step 2: quantified-claim drift across
transcripts, single-voice topics (with engagement signals), and the
prior-artifact baseline — what `artifacts/` already surfaced (pass
`--artifacts-dir` if it lives elsewhere).

### 2. Triage + draft (your judgment)

Read the chunks. Select only genuinely interesting material:

- non-obvious insights, decisions with reasoning, contrarian takes
- ideas worth developing further
- topics that recur across transcripts (when given a collection)
- knowledge only one person on the team seems to hold

**Each card's lead MUST be built from at least one novelty candidate:** a
quantified-drift finding, a single-voice topic, or a cross-transcript
connection no single speaker stated. The team attended these meetings —
an "interesting summary of what was said" is explicitly disqualified.
**Novelty baseline check:** a candidate a prior artifact already surfaced
is disqualified unless you can say something materially new about it —
justify that judgment in `quality.notes`.

For each candidate, draft an artifact JSON per the contract in
`skills/_shared/lib/artifact.ts`: `type: "insight-card"`, a sharp
`headline`, a short `body` (markdown), optional `quote`/`attribution`,
`tags`, `source_transcripts` (the input paths), and `source_quotes` —
**exact verbatim quotes** from the transcript that anchor every claim.
Never paraphrase inside `source_quotes`.

Write draft artifact JSONs to `drafts/` at the repo root (gitignored),
one file per candidate, e.g. `drafts/<slug>.json`. That is the sanctioned
pre-save workspace; `save.ts` moves survivors into `artifacts/`.

### 3. Critic pass (your judgment — mandatory)

Re-read each draft as a skeptical editor. Ask: Is this actually insightful,
or just meeting noise? Would the team learn something from this card? Is
every claim anchored to a real quote? **Discard sub-bar candidates — fewer,
better artifacts beats padded output. Zero artifacts is a valid result.**
Set `quality.critic_pass: true` only on survivors, with `quality.notes`
explaining what was cut and why.

**Then the adversarial novelty critic (mandatory, before saving):** argue
that the team already knows everything in each card — every beat was
plainly stated in a meeting they attended, or surfaced by a prior
artifact. If the argument holds for a card's lead, kill the card (zero
cards is valid); if it holds for individual beats, cut them. Record the
verdict in `quality.notes` with the novelty convention, e.g.
`[novelty] lead=cross-transcript: ...; adversarial critic: ...` (`lead=`
one of `quantified-drift` | `single-voice` | `cross-transcript`).

### 4. Verify quotes (script — mandatory before saving)

```sh
bun skills/extract-insights/scripts/verify-quotes.ts drafts/<slug>.json --stamp
```

Checks every `source_quotes[].quote` verbatim (whitespace-insensitive)
against the transcript's spoken text (parsed speaker turns — AI-generated
summary/action-item headers don't count). With `--stamp`, full success
writes `quality.quotes_verified: true` into the draft for you; on failure
nothing is stamped — fix or drop the failing quotes and re-run. Never
hand-set `quotes_verified`.

### 5. Save (script)

```sh
bun skills/extract-insights/scripts/save.ts drafts/<slug>.json [--out-dir artifacts]
```

Validates against the contract and writes
`<out-dir>/insight-card/<slug>/artifact.json`. Validation errors are
printed; fix the JSON rather than bypassing the script.

## Output contract

Every artifact lands at `artifacts/<type>/<slug>/artifact.json` with media
alongside. See `skills/_shared/lib/artifact.ts` for the full type. Feed UI
consumers read these folders later — keep the JSON strictly contract-valid.
