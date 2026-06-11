# Skill: make-podcast

Distill meeting/conversation transcripts into a **micro-podcast artifact**:
a 2–5 minute episode — tight script plus synthesized audio — built around
ONE compelling through-line. Works on a single transcript or a collection
(file paths or directories — always passed in, never assumed).

**The novelty bar (read first).** The listener ATTENDED these meetings.
An episode earns its runtime only by surfacing synthesis they couldn't
have done in the room: a quantified claim that drifted across meetings, a
topic only one person ever voices, a connection across transcripts that no
single speaker stated. A well-executed summary of what was said is a
failed episode, however polished.

Same division of labor as every distillery skill: **scripts do
deterministic plumbing** (parsing, TTS call, WAV assembly, AAC
compression, validation, persistence); **you — the agent — do the
judgment** (picking the episode angle, writing the script, critiquing
it).

## Prerequisites

- bun installed.
- `GEMINI_API_KEY` resolvable from env for the synthesize step only
  (`GOOGLE_AI_API_KEY` | `GEMINI_API_KEY` | `GOOGLE_API_KEY`, in that
  order). Copy the key from the TinyCloud Secret Manager into `.env` for
  now. Digest, verify, and save need no key.

## Live-verified 2026-06-10

The Gemini TTS request shape in `skills/_shared/lib/tts.ts` (built from
https://ai.google.dev/gemini-api/docs/speech-generation) was verified
against the live API on 2026-06-10: single-voice and 2-speaker
multi-speaker requests both succeeded unchanged, and the response was
base64 raw PCM with mime `audio/L16;codec=pcm;rate=24000`, exactly as
documented. No fixes were needed.

Documented surface (same doc): models `gemini-2.5-flash-preview-tts`
(our default), `gemini-2.5-pro-preview-tts`, `gemini-3.1-flash-tts-preview`;
output is raw PCM s16le, 24 kHz, mono, which `synthesize.ts` wraps into a
playable WAV; 30 prebuilt voices (Kore, Puck, Zephyr, Charon, Fenrir,
Leda, ...); max 2 speakers in multi-speaker mode; ~32k-token context;
no streaming.

## Procedure

Run all commands from the distillery repo root. Use a scratch dir (e.g.
`/tmp`) for intermediates; only `save.ts` writes into `artifacts/`.

### 1. Digest + novelty scan + narrative-seed scan (scripts)

```sh
bun skills/make-podcast/scripts/digest.ts <transcript-path>... [--max-chunk 8000] [--out digest.json]
bun skills/_shared/scripts/novelty-scan.ts <transcript-path>... --format md [--out novelty.md]
bun skills/make-podcast/scripts/narrative-seeds.ts <transcript-path>... --format md [--out seeds.md]
```

The digest accepts .md/.txt files or directories (recursed) and emits
JSON: `{ transcripts: [{path, title, date, participants, duration,
summary?}], chunks: [...] }`. `duration` is computed from the first/last
turn timestamps when present (Fireflies headers sometimes lie with
"Duration: 0 min"), falling back to the header value.

**The narrative-seed scan is the podcast's material-format-matching gate
— run it every time, BEFORE you pick a lead.** A card needs ONE insight;
a podcast needs a sustained THROUGH-LINE across meetings — development,
tension, a turn. That is a structurally higher bar, so the survey must
PRIORITIZE material that already shows temporal development (a real
before→after), not just any recent transcripts. `narrative-seeds.ts`
scores the candidate SET deterministically (no LLM) on index-available
signals and surfaces the **arc skeleton** — ranked seeds, each with its
chronological evidence chain. Three seed kinds:

- **quantified-drift** — a tracked quantity whose VALUE moved across 2+
  meetings (a number/commitment that changed over time = an inherent arc:
  "$100k to close" → "50 grand" → "eventually"). Identical values that
  merely recur score zero — that's a fact the room shares, not a story.
- **single-voice-arc** — a single-voice topic one person carries across
  3+ meetings, AND the room's engagement with it SHIFTS across the set
  (ignored early then engaged, or vice versa = stance development).
- **cross-meeting-topic** — an entity/term spanning 3+ meetings with 2+
  speakers, AND showing a SHIFT — it left and re-entered the agenda, or
  changed hands across voices (the thread spread).

**Recurrence is not development — for EVERY kind.** A topic that merely
repeats across meetings with no detected shift (single voice never
re-engaged, a thread the same person restates every standup) has its
development floored at 0: it sorts below every real arc and is labeled
"recurrence only, no detected development — surfaced as context, not an
arc," mirroring how identical recurring quantities score zero. Recurrence
may still be SURFACED as context, but it is never scored as an arc.

Seeds are ranked by `development × reach`; **a set with a real shift
(drift / engagement / voice-spread / agenda movement) scores above a flat
"here are interesting things" set by construction.** Every seed spans 2+
meetings — a signal confined to one meeting never appears (it's a card,
not a lead). **The scan is a
SURFACER, not a judge:** read each seed's evidence chain and decide
whether the arc is real. **Zero seeds means no through-line shows temporal
development — there is no episode lead** (do not synthesize a flat recap).

**Run the novelty scan alongside the digest — always.** It surfaces three
kinds of novelty CANDIDATES (deterministically; you judge them):

- **Quantified drift**: money/percent/count/deadline mentions grouped by
  topic across transcripts, in chronological order — e.g. "$100K to
  close" in one meeting lining up against "50 grand" two weeks later.
  The scan lines up the evidence; whether it's real drift is your call.
- **Single-voice topics**: terms only ONE speaker ever uses, with an
  engagement signal per mention (did anyone substantively reply within 3
  turns) — asymmetric-knowledge candidates.
- **Prior-artifact baseline**: every headline/tag/quote previous artifacts
  already surfaced (from `artifacts/`, or pass `--artifacts-dir`). This is
  what "already known" looks like — new angles must beat it.

### 2. Pick ONE through-line (your judgment)

Survey the digest + novelty scan + **narrative-seed scan** and choose a
single compelling through-line. One episode = one idea — do not stitch
together a grab-bag recap.

**The through-line MUST be built on a narrative seed that has temporal
development — a real before→after across meetings.** Start from the
ranked seeds in the narrative-seed scan: the episode's spine is one seed
whose evidence chain shows the story MOVING (a quantity that drifted, a
single-voice idea pushed across meetings, a topic the room returned to
with an evolving stance). Read the seed's chronological evidence chain and
confirm the development is real before committing.

In seed terms, the through-line MUST be built from at least one of:

1. a **quantified-drift seed** (a number/deadline that moved, softened, or
   vanished across meetings — cite the chronological evidence chain),
2. a **single-voice-arc seed** (knowledge one person carries across
   meetings that the room never engaged with — name the person, show the
   silence and how it persisted), or
3. a **cross-meeting-topic / cross-transcript connection no single speaker
   stated** (a thread the room kept returning to with an evolving stance;
   two meetings unknowingly answering each other's question; the same root
   cause surfacing under different names across the set).

**A flat "here are interesting things from recent meetings" is
disqualified as a lead — that's a card, not an episode.** If the
through-line is confined to one meeting, or could be reconstructed by
anyone who attended without lining up the across-meeting development, it
is not an episode. **If the narrative-seed scan returns zero seeds (no
through-line shows temporal development), output nothing** — see "Zero
episodes is a valid result" below.

**Novelty baseline check (mandatory).** Compare your candidate angle
against the scan's prior-artifact baseline. If a prior artifact already
surfaced it, the angle is disqualified — unless you can say something
materially new about it (the situation moved, new evidence landed). That
exception is your judgment call and must be justified in `quality.notes`.

**Zero episodes is a valid result.** If nothing clears the novelty bar,
stop and say so rather than synthesizing filler. TTS costs real money;
spend it on nothing rather than noise.

### 3. Write the script (your judgment)

Write `script.md` — the exact text that will be spoken. Good material only
lands if the craft lands, so write to an explicit **craft rubric** and
self-grade against it (the checklist below) before you touch the critic.

**Craft rubric — every episode must clear all six axes:**

1. **COLD OPEN** — drop into the most surprising concrete moment, not an
   intro. No "welcome to…", no "today we're talking about…". Open on the
   specific thing that changed ("Three weeks ago this round needed a
   hundred grand. Last Tuesday it was 'eventually.'").
2. **ARC** — a clear shape: setup → the turn/tension → where it landed.
   The seed's before→after IS the arc; make the listener feel the
   movement, not a list of facts.
3. **A TURN** — at least one earned moment where the story complicates: a
   number softens, a stance flips, two meetings collide. The turn is why
   it's an episode and not a card. Name it; don't bury it.
4. **CONCRETE over abstract** — specific numbers, names, dates, the actual
   words spoken. Cut every sentence that could appear in any episode about
   any company. Every factual claim must trace to a source line (collect
   the anchoring verbatim quotes now for `source_quotes`; step 4 verifies
   them — if you can't point at the line, cut the claim).
5. **DIALOGUE, not narration** (two-host format) — the hosts are in
   genuine exchange: one ADVANCES the story, the other PROBES or PUSHES
   BACK. Not two people alternating paragraphs of the same narration. A
   real question, a real disagreement, a "wait, but…". (Monologue format:
   skip this axis, but the single voice must still think out loud, not
   recite.)
6. **CLOSE on one concrete takeaway** — resolve to a single thing the
   listener can act on or repeat. No outro fluff, no "in today's
   fast-paced world", no recap of the recap.

Plus the always-on basics: **conversational, not corporate** (written for
the ear — short sentences, contractions, no slideware), **no filler**, and
**target 350–750 words** (~2–5 minutes at speaking pace).

**Self-grade checklist (run BEFORE the critic — this is mandatory).**
Grade the draft on each axis; weak on ANY axis → revise the script, don't
proceed:

- [ ] **Cold open** — does it drop into the most surprising concrete
      moment, not an intro?
- [ ] **Arc** — is there a clear setup → turn → landing, not a list?
- [ ] **Turn** — is there at least one earned moment where the story
      complicates?
- [ ] **Dialogue not narration** — do the two hosts genuinely
      advance/probe each other (or, monologue: think out loud)?
- [ ] **Concrete** — specifics (numbers, names, the actual words) over
      abstraction throughout?
- [ ] **Takeaway** — does it close on ONE concrete thing to act on or
      repeat?

Only a draft that passes all six goes to step 4. The self-grade is craft;
the critics in steps 4–5 are correctness + novelty — both still run.

Formats — the file content is sent to TTS verbatim:

- **Monologue:** plain prose. Optionally open with a one-line style
  direction (e.g. `Say in a warm, conversational tone:`) — the docs say
  natural-language prompts steer style, pace, and tone.
- **Dialogue (two hosts):** every line is a `Name: text` turn, exactly two
  names, and the names must match the `--speaker` labels in step 6, e.g.

  ```
  Alex: So the team killed seat-based pricing this week. I didn't see it coming.
  Sam: I did — power users were getting punished for caring.
  ```

Also draft the artifact JSON per `skills/_shared/lib/artifact.ts`:
`type: "podcast"`, a sharp `headline` (becomes the slug), `body` = a
2–3 sentence episode description (not the script), `tags`,
`source_transcripts` (the input paths), and `source_quotes` — exact
verbatim transcript quotes anchoring each factual claim in the script.

### 4. Critic pass (your judgment — mandatory, BEFORE any TTS spend)

Re-read the script as a skeptical editor. Would a busy teammate listen
past sentence two? Is every claim actually supported by the transcripts?
Does it earn its runtime, or does it pad? Is the takeaway concrete?
**Rewrite or kill — do not synthesize a script that didn't survive the
critic.** Set `quality.critic_pass: true` only on the survivor, with
`quality.notes` recording what was cut/changed and why.

Then verify the quote anchors (script — mandatory):

```sh
bun skills/make-podcast/scripts/verify-quotes.ts <artifact.json> --stamp
```

Fix or drop failures and re-run until exit 0. With `--stamp`, full
verification success writes `quality.quotes_verified: true` into the
artifact for you (atomic write); on any failure nothing is stamped, and
an empty `source_quotes` list (exit 0 but suspicious) is never stamped.
**Never hand-set `quotes_verified`** — `--stamp` is the only sanctioned
way.

### 5. Adversarial novelty critic (your judgment — mandatory, BEFORE any TTS spend)

A second, separate critic pass with one specific brief: **argue that the
team already knows everything in this script.** For every beat, make the
strongest case that it was plainly stated in a meeting they attended, or
has already been surfaced in a prior artifact (re-check the scan's
baseline). You are arguing FOR the kill.

- **If the argument holds for the LEAD** — the through-line itself is
  something an attendee already knew — **kill the episode.** Zero episodes
  is a valid result; say what died and why.
- **If it holds for individual beats**, cut those beats and re-check the
  script still stands without them.
- A beat survives only if the synthesis (the drift, the silence around a
  single voice, the cross-meeting connection) is the content — not the
  facts an attendee heard live.

Record the verdict and the surviving rationale in `quality.notes`, using
the novelty note convention:

```
[novelty] lead=quantified-drift: $100K-to-close (May 22) vs "eventually" (Jun 5); adversarial critic: cut beat 3 (restated standup status), lead survives — drift synthesis spans two meetings no attendee lined up.
```

(`lead=` is the narrative-seed kind the through-line was built on: one of
`quantified-drift` | `single-voice-arc` | `cross-meeting-topic`. The older
`single-voice` / `cross-transcript` spellings remain acceptable synonyms.)

### 6. Synthesize (script — needs GEMINI_API_KEY)

**First run on a machine/key: smoke-test with one sentence before
spending on the full episode** (TTS bills per request). Pass `--smoke` so
the deliberately tiny script doesn't trip the episode duration/pace
warnings — they're for real episodes, and a one-sentence clip is
*supposed* to be a few seconds long:

```sh
echo "This is a one-sentence smoke test." > /tmp/smoke.md
bun skills/make-podcast/scripts/synthesize.ts /tmp/smoke.md --voice Kore --out /tmp/smoke.wav --smoke
```

Play the clip; if it sounds right, synthesize the real episode (no
`--smoke`).

Monologue:

```sh
bun skills/make-podcast/scripts/synthesize.ts script.md --voice Kore --out episode.wav
```

Dialogue (speaker names must match the script's `Name:` labels; pick two
distinct voices — **suggested pairing: Kore + Puck**, live-verified
2026-06-10 as clearly distinct and natural together; don't guess blind
from the 30-voice list):

```sh
bun skills/make-podcast/scripts/synthesize.ts script.md \
  --speaker "Alex=Kore" --speaker "Sam=Puck" --out episode.wav
```

Optional: `--model gemini-2.5-pro-preview-tts` for higher quality.
The script wraps the raw PCM response into a playable WAV.

### 7. Sanity-check the output (your judgment)

`synthesize.ts` prints the bytes written, the duration implied by the
byte/byte-rate math, and the words-per-minute pace, and warns when either
is implausible. Confirm: the file exists and is non-trivial in size, the
duration is plausibly 2–5 minutes, and pace is roughly 110–220 wpm. If
anything looks off (truncated audio, absurd pace), re-synthesize before
saving — never save an episode you wouldn't press play on.

### 8. Save (script — also compresses the audio)

```sh
bun skills/make-podcast/scripts/save.ts <artifact.json> --audio episode.wav --script script.md [--out-dir artifacts]
```

Validates against the contract and writes
`<out-dir>/podcast/<slug>/artifact.json` with the audio and `script.md`
alongside. Validation errors are printed; fix the JSON rather than
bypassing the script.

WAV input is automatically compressed to AAC (`episode.m4a`, ~12x
smaller, plays natively in browsers) so every consumer — review page,
feed, sharing — gets a small web-playable file. Tool fallback chain, no
hard dependency on either (`skills/_shared/lib/compress.ts`):

1. `ffmpeg` (cross-platform)
2. `afconvert` (macOS built-in; `afconvert -f m4af -d aac in.wav out.m4a`,
   live-verified 2026-06-10)
3. neither installed → the WAV is saved as-is with a clear warning.

When compression succeeds, the artifact's `audio` field points at the
`.m4a` and `episode.wav` is kept alongside as the lossless master. Don't
set `audio` by hand — save.ts manages it.

## Output contract

Every artifact lands at `artifacts/podcast/<slug>/` containing
`artifact.json` + `episode.m4a` (compressed, web-playable — what `audio`
points at) + `episode.wav` (lossless master) + `script.md`. If neither
compressor was available, `episode.wav` stands alone and `audio` points
at it instead. See `skills/_shared/lib/artifact.ts` for the full type;
the required `quality { critic_pass, quotes_verified, notes? }` block
must reflect steps 4–5 above — keep the JSON strictly contract-valid.
`quality.notes` carries the optional `[novelty]` note (step 5's
convention): which candidate type the lead came from, the baseline-check
outcome, and the adversarial critic's verdict.
