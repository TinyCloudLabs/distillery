# Skill: make-cheap-video

Distill transcript-derived narrative into a **cheap 15-second video clip
artifact** using Gemini/Veo 3.1 Lite. This is the low-cost sibling of
`make-clip`: same `clip` artifact contract, same poster/caption/save path,
but a cheaper video generator and a lighter storyboard IR.

The output is still `artifacts/clip/<slug>/artifact.json` plus mp4 media, so
TinyFeed and `tc-publish` do not need a new render type.

## When to Use

Use this when the run wants video variety but not the full Seedance
reference-video spend. The result can be a fun perspective on the ideas in the
transcripts: allegory, anime, toy-scale reenactment, product metaphor,
documentary miniature, or any other visual wrapper that preserves the
emotional truth.

Do **not** use it for claims-heavy artifacts where literal fidelity matters
more than mood, or when the narrative needs strict character continuity across
a long fight. Veo Lite is cheap, but it is not a continuity engine.

## Model and Cost Posture

- Provider: Gemini API / Veo 3.1 Lite.
- Model: `veo-3.1-lite-generate-preview`.
- Segment limit: 4, 6, or 8 seconds.
- Skill default deliverable: **15 seconds**.
- Implementation: generate **two 8-second segments**, stitch, then trim to
  15 seconds.
- Default resolution: 720p.
- Default aspect: 16:9. Veo Lite does not expose make-clip's feed-native 1:1.

## Division of Labor

Same posture as `make-clip`:

- Scripts do deterministic plumbing: Veo calls, polling, downloading, ffmpeg
  stitching, captioning, validation, persistence.
- The invoking agent does judgment: mine the narrative, choose the metaphor,
  write the storyboard/segment prompts, run the critic gate.

No script in this skill mines transcripts or decides the narrative for you.

## Procedure

Run from the Artifactory repo root.

### 1. Mine a Narrative

Read the transcript paths passed by the run. Find one emotional truth or
reversal that benefits from a visual metaphor. Keep it small: 15 seconds buys
one setup, one turn, one button.

Write `narrative.md` using `templates/01-narrative.md`. Include:

- insider read and stranger read;
- visual metaphor;
- source transcript paths;
- exact source quotes with transcript paths;
- target style and emotional button.

### 2. Storyboard Before Video

Write `storyboard.md` using `templates/02-storyboard.md`.

This is the cheap narrative compression pass. Treat it as a strict 15-second
shot plan split into two Veo Lite segments:

- Segment A: 0-8s, setup -> turn.
- Segment B: 8-15s, reveal -> button.

Avoid cramming a full plot into either segment. Each segment gets 2-3 beats.
Use strong camera language and audio cues. No in-frame text.

### 3. Write Segment Prompts

Write two prompt files from `templates/03-veo-segment.md`:

- `/tmp/work/segment-01.prompt.md`
- `/tmp/work/segment-02.prompt.md`

Each prompt must stand alone. Veo Lite segment 2 cannot rely on hidden state
from segment 1, so restate character, place, style, and current situation.

### 4. Generate Two Veo Lite Segments

Requires `GEMINI_API_KEY` (or `GOOGLE_AI_API_KEY` / `GOOGLE_API_KEY`) in env,
following `skills/_shared/lib/secrets.ts`.

```sh
bun skills/make-cheap-video/scripts/generate-video.ts /tmp/work/segment-01.prompt.md \
  --out /tmp/work/segment-01.mp4 --duration 8 --resolution 720p --aspect 16:9

bun skills/make-cheap-video/scripts/generate-video.ts /tmp/work/segment-02.prompt.md \
  --out /tmp/work/segment-02.mp4 --duration 8 --resolution 720p --aspect 16:9
```

### 5. Stitch to the 15s Default

```sh
bun skills/make-cheap-video/scripts/stitch.ts \
  /tmp/work/segment-01.mp4 /tmp/work/segment-02.mp4 \
  --out /tmp/work/clip.mp4 --target-duration 15
```

The stitcher re-encodes via ffmpeg and trims to the target runtime. Default
skill runtime is 15 seconds even though the provider calls are 8-second
segments.

### 6. Critic Gate

Reuse the `make-clip` gate:

```sh
bun skills/make-clip/scripts/extract-frames.ts /tmp/work/clip.mp4 \
  --out-dir /tmp/work/frames --count 8 --audio /tmp/work/frames/audio.aac
```

Ask a context-free reviewer what literally happened, what emotion/story they
read, where continuity broke, and what metaphor they infer. `critic_pass:
true` only when a cold viewer can reconstruct the intended emotional truth.

### 7. Optional Caption

Captioning is identical to `make-clip`; never ask Veo to render text.

```sh
bun skills/make-clip/scripts/caption.ts /tmp/work/clip.mp4 \
  --out-captioned /tmp/work/clip-captioned.mp4 \
  --out-clean /tmp/work/clip-clean.mp4 \
  --text "the idea in one line" --duration 15
```

If no caption is needed, still emit the pair:

```sh
bun skills/make-clip/scripts/caption.ts /tmp/work/clip.mp4 \
  --out-captioned /tmp/work/clip-captioned.mp4 \
  --out-clean /tmp/work/clip-clean.mp4
```

### 8. Save as a Normal Clip Artifact

Draft `artifact.json` with `type: "clip"` and
`generation_model: "veo-3.1-lite-generate-preview"`, then reuse the
`make-clip` save script:

```sh
bun skills/make-clip/scripts/save.ts artifact.json \
  --video /tmp/work/clip-captioned.mp4 \
  --clean /tmp/work/clip-clean.mp4 \
  --narrative narrative.md \
  --out-dir artifacts
```

The save script samples `poster.png`, records the mp4 in `video`, and preserves
the clean cut as a `video-clean:<file>` tag.

## Quality Notes

`quality.notes` should include:

- `[novelty] lead=<type>: ...`;
- `[cheap-video] model=veo-3.1-lite-generate-preview target=15s segments=8+8`;
- metaphor distance and critic verdict;
- any visible continuity issue introduced by stitching.

Zero videos is valid. If the narrative is weak, the storyboard is overstuffed,
or the stitched result fails the cold-viewer gate, save nothing and state why.
