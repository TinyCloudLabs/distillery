# distillery

Agent-agnostic skills that distill meeting/conversation transcripts into
artifacts: illustrated insight cards, editorial articles with images, and
micro-podcasts. Point any agent (Claude Code, Codex, Cursor, ...) at a
skill's `SKILL.md` with transcript paths and it produces feed-ready
artifacts under `artifacts/`.

## Layout

```
skills/
  _shared/lib/        shared plumbing every skill imports
    secrets.ts        getSecret(): TinyCloud vault → env-var fallback chain
    transcript.ts     parse/load/chunk transcripts, verify quotes
    artifact.ts       the artifact output contract + writer
    gemini.ts         Gemini image (nano-banana) + text helpers
  extract-insights/   one skill = one folder (the template)
    SKILL.md          instructions any agent can follow
    scripts/          small bun scripts: deterministic plumbing only
tests/                bun test suite (synthetic fixtures, no real APIs)
SPEC.md               vision, architecture, decisions
```

## How an agent invokes a skill

1. Read the skill's `SKILL.md` (e.g. `skills/extract-insights/SKILL.md`).
2. Run its scripts with `bun skills/<skill>/scripts/<script>.ts <args>` from
   the repo root. Transcript paths (.md/.txt files or directories) are
   always passed as arguments — nothing is hardcoded to any machine.
3. The agent supplies judgment (selection, drafting, critic pass); the
   scripts supply plumbing (parsing, chunking, quote verification,
   validation, persistence).

Skills are independently callable — no skill depends on another having run.

## Secrets

`getSecret("GEMINI_API_KEY")` tries the TinyCloud secrets vault
(`secrets/GEMINI_API_KEY` in the `secrets` space at secrets.tinycloud.xyz;
headless transport pending), then env vars
`GOOGLE_AI_API_KEY` | `GEMINI_API_KEY` | `GOOGLE_API_KEY`. Copy
`.env.example` to `.env` for local env-based setup.

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```
