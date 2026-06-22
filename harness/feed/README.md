# Legacy Folio Feed Harness

This directory is the older local Distillery/Folio feed server and PWA. It reads
repo-local `artifacts/`, `feedback/`, and `PREFERENCES.md`, serves a local
OpenKey-gated feed, and exposes older `/api/generate` behavior that shells into
the `harness/feed-run` recipe.

It is **not** the active Artifactory/Feed migration path. Current development
uses:

- `submodules/feed/` for the TinyCloud-backed Feed UI;
- `harness/agent/` for delegated Listen-read -> artifact generation -> publish;
- `harness/feed-run/` for deterministic recipe/backpressure tests that have not
  yet moved fully into the delegated agent path.

Keep this directory only until old local launchd jobs and any remaining useful
behavior have been migrated. Do not add new product work here; port it to the
active Feed submodule or the agent harness instead.
