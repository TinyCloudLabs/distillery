// artifact-schema.ts — the EXACT §1 DDL of the greenfield contract, as the
// single source of truth for the three application-space databases. The
// bootstrap script creates them; tc-publish writes the `artifact` table; the
// distill loop reads `interaction` and advances `distill_cursor`.
//
// Three DBs in the `applications` space — the privilege split is structural
// (DB-path is the cap granularity), not conventional:
//   feed         — `artifact`        (agent-write, reader-read)
//   interactions — `interaction`     (reader-write append-only, agent-read)
//   control      — `distill_cursor`  (agent-only)
//
// Every statement is idempotent (CREATE TABLE/INDEX IF NOT EXISTS) so the
// bootstrap can run on every workflow start.

/** The render-type viewer enum (precomputed at publish; §4). V1 = tweet|article. */
export const RENDER_TYPES = ["tweet", "article", "video"] as const;
export type RenderType = (typeof RENDER_TYPES)[number];

/** A logical DB in the artifacts namespace, addressed via `--db`. */
export interface ArtifactDb {
  /** The `--db` value, e.g. "xyz.tinycloud.artifacts/feed". */
  db: string;
  /**
   * Tables — REQUIRED. The node's SQLite authorizer permits CREATE TABLE.
   * A failure here is a hard error (the storage target is unusable).
   */
  tables: string[];
  /**
   * Indexes — BEST-EFFORT. The node's SQLite authorizer currently REJECTS
   * `CREATE INDEX`/`CREATE UNIQUE INDEX` with "not authorized" regardless of
   * cap (server-side constraint, not a capability gap). Bootstrap attempts
   * them and reports each rejection loudly — never silently. They are query
   * accelerators; correctness does not depend on them EXCEPT
   * `uq_interaction_nonce`, whose replay-protection role moves to the distill
   * layer (dedup on (reader_did, nonce) + recorded_at, per §1.2) until the
   * node permits the UNIQUE index.
   */
  indexes: string[];
}

const FEED_DDL = `CREATE TABLE IF NOT EXISTS artifact (
  id                 TEXT PRIMARY KEY,
  type               TEXT NOT NULL,
  render_type        TEXT NOT NULL,
  slug               TEXT NOT NULL,
  headline           TEXT NOT NULL,
  body_md            TEXT,
  quote              TEXT,
  attribution        TEXT,
  tags               TEXT NOT NULL DEFAULT '[]',
  source_transcripts TEXT NOT NULL DEFAULT '[]',

  hero_image_key     TEXT,
  hero_image_sha256  TEXT,
  hero_image_mime    TEXT,
  audio_key          TEXT,
  audio_sha256       TEXT,
  audio_mime         TEXT,
  video_url          TEXT,

  audience           TEXT,
  approval_status    TEXT NOT NULL,
  platform           TEXT,

  generation_model   TEXT,
  critic_pass        INTEGER NOT NULL DEFAULT 0,
  quotes_verified    INTEGER NOT NULL DEFAULT 0,

  raw_artifact       TEXT NOT NULL,
  generated_at       TEXT NOT NULL,
  published_at       TEXT NOT NULL,
  publisher_did      TEXT NOT NULL,
  schema_version     INTEGER NOT NULL DEFAULT 1
)`;

const INTERACTION_DDL = `CREATE TABLE IF NOT EXISTS interaction (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  action        TEXT NOT NULL,
  note          TEXT,
  reader_did    TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
)`;

const CURSOR_DDL = `CREATE TABLE IF NOT EXISTS distill_cursor (
  k                   TEXT PRIMARY KEY DEFAULT 'singleton',
  last_recorded_at    TEXT NOT NULL,
  last_id             TEXT NOT NULL,
  learned_fingerprint TEXT NOT NULL,
  updated_at          TEXT NOT NULL
)`;

/** All three DBs with their exact §1 DDL, in bootstrap order. */
export const ARTIFACT_DBS: readonly ArtifactDb[] = [
  {
    db: "xyz.tinycloud.artifacts/feed",
    tables: [FEED_DDL],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_artifact_published_at ON artifact(published_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_render_type  ON artifact(render_type, published_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_artifact_audience     ON artifact(audience, approval_status)`,
    ],
  },
  {
    db: "xyz.tinycloud.artifacts/interactions",
    tables: [INTERACTION_DDL],
    indexes: [
      `CREATE INDEX IF NOT EXISTS idx_interaction_artifact ON interaction(artifact_id)`,
      `CREATE INDEX IF NOT EXISTS idx_interaction_distill  ON interaction(recorded_at, id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_nonce ON interaction(reader_did, nonce)`,
    ],
  },
  {
    db: "xyz.tinycloud.artifacts/control",
    tables: [CURSOR_DDL],
    indexes: [],
  },
];
