# Skill: quote-card

The **visual packaging lift**. Take a strong line from an already-**APPROVED**
artifact (a `social-post`, `insight-card`, or anything with a sharp `quote` or
`headline`) and render it as a high-signal, **minimal** text-on-image quote
card — the kind of premium, high-contrast asset you'd actually post.

Output: a `quote.png` (or `.jpg`/`.webp`, per the model's mimeType) plus a new
**`quote-card` artifact** carrying the source's provenance. The card artifact
starts at `approval_status: "pending"` — **nothing outward-facing
auto-publishes**, and the visual is its own thing to approve, separate from the
copy that was already approved.

As everywhere in distillery: the **script does the plumbing** (gate on
approval, call the image model, write `quote.<ext>` + a contract-valid
`artifact.json`, append quality notes); **you — the agent — do the judgment**
(craft the visual-concept prompt, pick the line, view the result, zoom-inspect
any baked text, decide retry or accept). No model call lives in the script.

## Operates on APPROVED content only

This is a hard gate, enforced by the script: the source artifact's
`approval_status` **must be `"approved"`**. If it's `"pending"` (the default for
outward types) or unset, the script refuses and exits non-zero. Get the copy
through its human-approval gate first; only then package it.

## Prerequisites

- bun installed.
- A Gemini API key in env: `GOOGLE_AI_API_KEY` | `GEMINI_API_KEY` |
  `GOOGLE_API_KEY` (first match wins). Images cost ~$0.039 each
  (`gemini-2.5-flash-image`, "nano-banana").

> **Until live-verified:** this skill's unit tests run against a fake image
> provider — there is no Gemini key on the dev machine. The first real run
> needs a key exported; treat that run as the live verification and fix
> anything it surfaces.

## Text-in-image: two modes, and which to choose

The image model garbles long text. **Default to `composited`** and only reach
for `model-baked` when the line is short and the render survives
zoom-inspection.

- **`composited` (default, SAFE).** Prompt the model for a *clean
  background/motif only* — explicitly forbid all text — and reserve a calm,
  empty region (e.g. centered, lower-third) where the quote line will be
  overlaid as real, crisp type **outside this skill** (in a design tool, or a
  later compositing step). The card you ship has perfect text because the model
  never touched it. State in your prompt: "leave the central area clean and
  uncluttered for text overlay."
- **`model-baked` (only when it passes inspection).** Let the model render the
  quote line itself. Viable **only** for a short line (a few words), in a
  common sans-serif, high-contrast on a plain field. You **must** zoom-inspect
  the rendered text character-by-character before accepting — the model
  silently produces near-right-but-wrong letterforms and dropped/duplicated
  words. If anything is off, reject (don't ship garbled type) and either retry
  or switch to `composited`.

Pass your choice with `--text-mode`; it's recorded in the artifact's quality
notes so the human at the approval gate knows whether text still needs
compositing.

## Aesthetic

High-contrast, minimal, premium — Stripe / Linear / Vercel, not stock-photo
inspirational-quote. One idea, lots of negative space, a restrained palette,
confident typography area. The line is the hero; the image is the frame.

**Hard rules — state them verbatim in every prompt:**

- For `composited`: **NO text, words, letters, or numbers anywhere** — leave a
  clean region for overlay.
- For `model-baked`: the **only** text permitted is the exact quote line; **no
  other** words, no captions, no watermarks, no UI chrome.
- **NO logos, brand marks, or realistic depictions of named products.**
- **NO realistic faces or identifiable real people** (silhouettes / generic
  figures OK).

### Worked prompt examples

**Line: "Ship the demo before the deck."** (composited)

> *Minimal premium quote-card background, 1:1. Deep ink-navy field with a
> single thin coral diagonal line sweeping from lower-left, lots of negative
> space. Leave the central area completely clean and uncluttered for a text
> overlay added later. High-contrast, flat, Linear/Vercel aesthetic. NO text,
> words, letters, or numbers anywhere. No logos, no faces, no photorealism.*

**Line: "Earned secrets compound."** (model-baked — short enough to try)

> *Minimal premium quote card, 1:1. The exact phrase "Earned secrets compound."
> set in a clean bold sans-serif, off-white type centered on a deep forest-green
> field, generous margins, high contrast. That phrase is the ONLY text in the
> image — no other words, captions, watermarks, or numbers. No logos, no faces,
> no photorealism.*  → then zoom-inspect every character before accepting.

## Identity grounding

If the line names or implies a person, do not assert an inferred person-claim
as fact (affiliation, title, role) the source doesn't support. The card's
attribution rides through from the source artifact; don't invent one. State a
person's identity only when the source supports it.

## Procedure

Run all commands from the distillery repo root. Quality beats quantity: one
clean card, or none ("zero is valid").

### 1. Read the source (your judgment)

Open `<source-dir>/artifact.json`. Confirm `approval_status: "approved"`. Pick
the **line** — the sharpest, most quotable sentence. Default is the source's
`quote`, then `headline`; override with `--line` when a tighter line lives in
the body. Keep it short; long lines kill the minimal aesthetic and break
`model-baked` text.

### 2. Craft the visual-concept prompt (your judgment)

Pick a text mode (above), write the prompt to the aesthetic and the hard rules.
For `composited`, design the empty region; for `model-baked`, embed the exact
line and forbid all other text.

### 3. Generate (script)

```sh
bun skills/quote-card/scripts/quote-card.ts \
  --source-dir artifacts/social-post/<slug> \
  --prompt "..." \
  [--line "exact line"] [--aspect 1:1] \
  [--text-mode composited|model-baked] \
  [--note "..."] [--skip-existing]
```

- `--prompt` or `--prompt-file` (exactly one). Use a file for long prompts.
- `--aspect` defaults to `1:1` (square, the safest social quote-card format;
  pass `9:16` for stories, `16:9` for slides).
- `--text-mode` defaults to `composited`.
- `--note` is appended to the card's quality notes (use on retries to record
  what was wrong with the previous attempt).
- `--skip-existing` exits cleanly without generating (and without re-billing)
  when the quote-card already exists with its image on disk.

The script gates on approval, writes `quote.<ext>` into
`artifacts/quote-card/<slug-of-line>/`, writes a contract-valid `quote-card`
`artifact.json` carrying the source's `source_transcripts`/`source_quotes`/
`tags`/`attribution`, and exits non-zero on failure. The new artifact is
`pending` by default. Never edit `hero_image`/`approval_status` by hand.

### 4. Quality loop — view and judge (your judgment, mandatory)

You can read image files. **View the generated card** and judge it:

1. **Premium and minimal?** Reads like Stripe/Linear, not a stock quote
   graphic? One idea, real negative space?
2. **Text artifacts?** For `composited`: any letters/pseudo-words the model
   sneaked in → reject. For `model-baked`: **zoom-inspect every character** of
   the line; any wrong/dropped/duplicated letter → reject.
3. **Hard-rule violations?** Logos, faces, named products, garbled elements →
   reject.

If sub-bar, refine — simplify, switch text mode, restate the hard rules — and
rerun step 3 with `--note "retry: <what was wrong>"`. Retries overwrite
`quote.<ext>` in place; copy the current one aside (e.g. to `/tmp`) first if you
want to compare. **Max 2 retries** (3 generations total); past that, keep the
best and say what's still wrong.

### 5. Record the outcome (script)

After accepting (or exhausting retries):

```sh
bun skills/quote-card/scripts/quote-card.ts \
  --quote-dir artifacts/quote-card/<slug> \
  --annotate "card reviewed: minimal, no stray text; text overlay still TODO (composited)"
```

`--annotate` appends to quality notes without generating. Be honest about
what's left (e.g. composited text not yet overlaid, or a flawed best-of-three).

## Output contract

```
artifacts/quote-card/<slug-of-line>/
  artifact.json    type "quote-card", quote = the line, hero_image = "quote.png",
                   approval_status "pending", provenance carried from source
  quote.png        (or quote.jpg / quote.webp per the model's mimeType)
```

`hero_image` is always a file name relative to the artifact's own folder, per
the contract in `skills/_shared/lib/artifact.ts`. The card ships only after a
**human approves it** — this skill never flips `approval_status`.
