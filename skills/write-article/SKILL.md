# Skill: write-article

Turn one transcript or a collection of transcripts into an **editorial
article artifact**: a headline, a dek, a ~400-900 word markdown body, pull
quotes anchored to source, and tags. The article's purpose is to surface
insights, recurring topics across meetings, and the team's asymmetric
knowledge — things one person knows that others keep asking about.

The **scripts do deterministic plumbing** (parsing, digesting, quote
verification, validation, persistence); **you — the agent — do the
editorial work** (angle selection, outlining, drafting, critiquing). No
script in this skill calls a model. Any agent that can run bun can use it.

## Prerequisites

- bun installed.
- No API keys required. Transcript paths (.md/.txt files or directories)
  are always passed at invocation time — nothing is hardcoded to any
  machine.

## Two modes

- **Single transcript** — one path. Eligible angles: a non-obvious insight,
  a decision with its reasoning, or one person's asymmetric knowledge
  surfaced in that conversation.
- **Collection** — multiple `--transcript`-style paths or a directory
  (recursed). All single-mode angles remain available, plus the
  cross-transcript angle: a topic that recurs across meetings, or knowledge
  one person keeps supplying while others keep asking. **The
  recurring-topics angle requires at least 2 transcripts** — the digest's
  `mode` field tells you which mode you're in; never claim a topic "keeps
  coming up" from a single meeting.

## Procedure — the quality loop

Run all commands from the distillery repo root. Quality beats quantity at
every step: one good article, or none.

### 1. Survey (scripts)

```sh
bun skills/write-article/scripts/survey.ts <transcript-path>... [--max-chunk 8000] [--format json|md] [--out digest.json]
bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... --format md [--out novelty.md]
```

**Run the novelty scan alongside the survey — always.** It surfaces
novelty CANDIDATES you judge in step 2: quantified-claim drift across
transcripts (chronological evidence), single-voice topics (terms only one
speaker uses, with engagement signals), and the prior-artifact baseline
(what `artifacts/` already surfaced — pass `--artifacts-dir` if it lives
elsewhere).

Emits a digest: `mode` ("single" | "collection"), per-transcript metadata
(title, date, participants, summary, per-speaker turn counts in
`speakerTurnCounts`), and — in collection mode —
`crossTranscript.sharedSpeakers` and `crossTranscript.recurringTerms`
(stopword-filtered term-frequency **hints only**, never conclusions — read
the chunks before claiming anything recurs), plus the full chunked
transcript text. Read all of it before deciding anything.

`--format md` renders the same digest as a readable markdown document
(metadata up top, chunks as plain text sections) — usually the better
choice for reading; the default JSON is for programmatic use.

### 2. Select ONE editorial angle (your judgment)

Pick the single strongest angle the material supports:

- a non-obvious insight or a decision whose reasoning matters
- a topic that genuinely recurs across transcripts (collection mode only)
- asymmetric knowledge: something one person knows that others keep asking
  about — name the person, show the questions

**The angle MUST be built from at least one novelty candidate:** a
quantified-drift finding, a single-voice topic, or a cross-transcript
connection no single speaker stated. The readers attended these meetings —
an "interesting summary of what was said" is explicitly disqualified as a
lead. **Novelty baseline check:** if a prior artifact (see the scan's
baseline section) already surfaced the angle, it's disqualified unless you
can say something materially new about it — justify that judgment in
`quality.notes`.

The bar: **would a smart team member who attended none of these meetings
learn something non-obvious?** If no angle clears that bar, stop here and
output nothing. **Zero artifacts is a valid result** — say so and why.
Never stretch thin material into an article; never combine two weak angles
into one mushy piece.

### 3. Outline (your judgment)

Sketch before drafting: the headline claim, the dek, 3-5 body beats, and
which exact transcript quotes anchor each beat. If you can't find a real
quote for a beat, cut the beat. The outline is scratch work — don't save it.

### 4. Draft (your judgment)

Write the article as markdown in the artifact's `body` field. Structure:

- Line 1: the **dek** — one italic standalone line (`*Like this.*`) that
  earns the click without restating the headline.
- Then 400-900 words of body. Pull quotes appear inline as blockquotes:
  `> Exact quote here. — Speaker Name`
- Every pull quote and every factual claim must be anchored by an entry in
  `source_quotes` (exact verbatim transcript text — never paraphrase
  inside `source_quotes`; paraphrase in prose is fine when a verbatim
  anchor for the underlying fact still exists).

**Check each quote the moment you draft it** — don't wait for the final
verify pass to discover a paraphrase:

```sh
bun skills/_shared/scripts/check-quote.ts --quote "exact words you plan to use" <transcript-path>...
```

It checks the quote against each transcript (same matching as
verify-quotes) and prints the matching speaker turn when found. Exit 0 =
found somewhere; exit 1 = found nowhere, so fix the wording before it
reaches the draft.

**Attribution:** attribute quotes per the transcript's speaker labels —
they're the only attribution source you have — but know that diarization
labels can be wrong (Fireflies has put one speaker's lines under another's
name). Quote verification proves the *text* was spoken, not *who* spoke
it. Record this caveat in `quality.notes`. If turn counts or content make
an attribution look implausible (one person answering their own
questions), flag it explicitly there too.

Write the draft artifact JSON to `drafts/<slug>.json` at the repo root
(gitignored) — that is the sanctioned pre-save workspace; `save.ts` moves
survivors into `artifacts/`.

Fill the rest of the artifact per `skills/_shared/lib/artifact.ts`:
`type: "article"`, `headline`, the lead pull quote in `quote` +
`attribution`, `tags`, `source_transcripts` (the input paths as given),
`source_quotes`, and `generation_model` naming you, the drafting agent.
Leave `hero_image` unset (or `null` — the save script strips it):
illustration is the separate, independently-callable **illustrate-card**
skill, which can be pointed at this artifact later. Don't generate or
reference images here.

#### Writing quality — read before drafting

Write like a sharp newsletter editor, not a press release. Specifically:

- **No inflated symbolism.** Ban "testament to", "underscores",
  "highlights the importance of", "speaks volumes". Say what happened and
  why it matters; don't announce that it matters.
- **No rule-of-three padding.** "Fast, simple, and reliable" is filler
  unless all three earned their place. One precise word beats three vague
  ones.
- **No em-dash overuse.** A couple per article, tops. If every third
  sentence pivots on a dash, rewrite.
- **Banned vocabulary:** delve, landscape, tapestry, journey, robust,
  seamless, leverage (as a verb), game-changer, crucial, pivotal,
  "in today's fast-paced world".
- **No negative parallelisms.** "Not just X, but Y" / "It isn't about X;
  it's about Y" — cut, state Y directly.
- **Vary sentence length.** Some short. Some longer, when the thought needs
  room. A wall of medium sentences reads machine-made.
- **Concrete over abstract.** Names, numbers, dates, quoted words. "Ada
  rejected per-seat pricing because it punishes power users" beats "the
  team explored pricing optimization strategies".
- The transcript quotes are your best material — let people speak in their
  own words rather than summarizing them into mush.

### 5. Critic pass (your judgment — mandatory)

Re-read the full draft as a skeptical editor. Judge it against these named
criteria, each pass/fail:

1. **Non-obvious value** — would a smart team member learn something they
   didn't already know? If it reads like meeting minutes with a headline,
   kill it.
2. **Anchoring** — is every factual claim and every pull quote backed by a
   `source_quotes` entry? Unanchored claims get cut or anchored, not
   hedged.
3. **No generic filler** — does any paragraph survive only because it's
   inoffensive? Does the draft violate the writing-quality rules above?
   Rewrite or cut.

If the draft fails criterion 1 after one honest rewrite, discard the whole
article — back to step 2 or output nothing. Record the verdict in
`quality.notes` (what was cut, what was rewritten, or why nothing
shipped). Set `quality.critic_pass: true` only on a survivor.

**Then the adversarial novelty critic (mandatory, before saving):** argue
that the team already knows everything in this draft — every beat was
plainly stated in a meeting they attended, or surfaced by a prior
artifact. If the argument holds for the LEAD, kill the article (zero
artifacts is valid). If it holds for individual beats, cut them. Record
the verdict in `quality.notes` with the novelty convention, e.g.
`[novelty] lead=single-voice: ...; adversarial critic: ...` (`lead=` one
of `quantified-drift` | `single-voice` | `cross-transcript`).

### 6. Verify quotes (script — must exit 0)

```sh
bun skills/write-article/scripts/verify-quotes.ts drafts/<slug>.json --stamp
```

Checks every `source_quotes[].quote` verbatim (whitespace-insensitive)
against its transcript. An empty `source_quotes` list fails — articles
without anchors don't ship. Fix or drop failing quotes (and the claims
that depended on them), then re-run until exit 0. With `--stamp`, full
success writes `quality.quotes_verified: true` into the draft for you
(atomic write); on any failure nothing is stamped. **Never hand-set
`quotes_verified`** — `--stamp` is the only sanctioned way. Remember:
this proves the text, not the attribution (see the drafting-step caveat).

### 7. Save (script)

```sh
bun skills/write-article/scripts/save.ts drafts/<slug>.json [--out-dir artifacts]
```

Validates against the contract and writes
`<out-dir>/article/<slug>/artifact.json` **plus `body.md` alongside** (the
markdown body as a standalone file). Warns if the body falls outside the
~400-900 word target. Validation errors are printed; fix the JSON rather
than bypassing the script.

## Output contract

`artifacts/article/<slug>/artifact.json` + `body.md` in the same folder.
See `skills/_shared/lib/artifact.ts` for the full type. `hero_image` is
absent at save time; the illustrate-card skill adds it independently
later. Keep the JSON strictly contract-valid — the future feed UI consumes
these folders directly.
