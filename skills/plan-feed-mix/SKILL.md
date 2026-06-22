# Skill: plan-feed-mix

Plan the artifact mix before generating artifacts for TinyFeed.

This skill does not publish anything and does not call a model by itself. The
invoking agent uses it as the first judgment pass in a run: choose which
artifact formats to attempt, reserve rich-media slots when providers are ready,
and write down skip reasons so operators can see why a feed run did or did not
produce video, audio, images, or text.

## When to Use

Use this at the start of every delegated Feed generation run, before opening the
format-specific skills (`hot-take`, `write-article`, `make-podcast`,
`make-cheap-video`, `make-clip`, etc.).

## Policy

1. Start from the run target:
   - explicit `artifactType:"clip"` means a publishable video clip is the proof;
   - explicit `artifactType:"podcast"` means a real audio artifact is the proof;
   - explicit `artifactType:"article"` means an article with a real hero image
     is the proof when Gemini is available;
   - `auto` means compose a good feed, not only the easiest text artifacts.
2. If video is enabled, reserve one publishable slot for a clip attempt in
   `auto` / balanced runs. Prefer `make-cheap-video` with Gemini/Veo. Use
   `make-clip` only when the higher-control FAL/Seedance path is specifically
   useful.
3. A clip candidate does not need a perfect editorial twist. It needs one clear,
   transcript-grounded visual metaphor or reversal that can be understood in
   about 15 seconds.
4. Fill the remaining slots with the strongest mix the corpus earns:
   hot-takes for compact operating lessons, articles for developed narrative
   threads, podcasts for sustained temporal through-lines, digests for related
   clusters, and person briefs only when identity evidence is strong.
5. Treat Feed interactions as weak backpressure, not a hard preference model.
   Early likes/dislikes should steer exploration lightly, not collapse the feed
   into one artifact type.
6. Do not create placeholder media shells. If a reserved rich-media slot is
   skipped, name the reason: no candidate, provider unavailable, generation
   failed, quality failed, quote evidence too thin, or duplicate of an existing
   artifact.

## Output

Write a short `mix-plan.md` into the run artifacts directory before generating
artifacts. This file is operator-visible scratch, not a published artifact.

Use this shape:

```md
# Artifact Mix Plan

- run target: auto | clip | podcast | article | ...
- publishable cap: N
- reserved slots:
  - clip: attempt | skip — reason
  - podcast: attempt | skip — reason
  - article/image: attempt | skip — reason
- candidate transcripts:
  - <path>: <format> — <why this format fits>
- skip notes:
  - <format>: <reason>
```

Keep the plan compact. The point is to make selection inspectable, not to write
a second article before generating artifacts.
