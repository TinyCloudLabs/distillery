// Feed v1 schema resources for TinyCloud app-kit style manifests.
//
// Runtime setup should call:
//   sql.db(resource.name).migrations.apply({ namespace, migrations })
// rather than issuing ad hoc schema SQL in hot paths.

export type FeedV1SqlResourceName = "artifacts_index" | "feed_index";

export type FeedV1SchemaMigration = {
  id: string;
  description: string;
  sql: string[];
};

export type FeedV1SqlResource = {
  name: FeedV1SqlResourceName;
  engine: "sqlite";
  schema: string;
  description: string;
  capabilities: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"];
  migrations: FeedV1SchemaMigration[];
  sensitivity: "derived" | "user-data";
};

export type FeedV1AppSchema = {
  namespace: "xyz.tinycloud.feed.v1";
  resources: {
    sql: FeedV1SqlResource[];
  };
};

export const FEED_V1_ARTIFACTS_MIGRATIONS: FeedV1SchemaMigration[] = [
  {
    id: "001_artifacts_index",
    description: "Create greenfield Artifacts index, package state, run ledger, source refs, cost ledger, and worker lock tables.",
    sql: [
      `CREATE TABLE IF NOT EXISTS artifact_index (
  artifact_id TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL,
  package_id TEXT NOT NULL,
  package_version TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  artifact_fingerprint TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  doc_key TEXT NOT NULL,
  media_keys_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS workflow_package_state (
  package_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  digest TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  workflow_ref TEXT NOT NULL,
  workflow_digest TEXT NOT NULL,
  admission_state TEXT NOT NULL,
  disclosure_json TEXT NOT NULL,
  enabled_at TEXT,
  paused_at TEXT,
  updated_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS workflow_run_index (
  run_id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  published_artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  dropped_candidates_json TEXT NOT NULL DEFAULT '[]',
  spend_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
)`,
      `CREATE TABLE IF NOT EXISTS source_ref (
  source_ref_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  observed_path TEXT NOT NULL,
  observed_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  quote_line_refs_json TEXT NOT NULL DEFAULT '[]'
)`,
      `CREATE TABLE IF NOT EXISTS source_cursor (
  cursor_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  observed_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS cost_ledger (
  ledger_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  spend_class TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  run_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS run_lock (
  lock_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  fencing_token TEXT NOT NULL
)`,
    ],
  },
];

export const FEED_V1_FEED_MIGRATIONS: FeedV1SchemaMigration[] = [
  {
    id: "001_feed_index",
    description: "Create greenfield Feed projection, feedback, preferences, generation request, and control intent tables.",
    sql: [
      `CREATE TABLE IF NOT EXISTS feed_artifact_projection (
  artifact_id TEXT PRIMARY KEY,
  rank_score REAL NOT NULL,
  disposition TEXT NOT NULL,
  visibility TEXT NOT NULL,
  freshness_label TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  package_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS projection_checkpoint (
  checkpoint_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  artifact_cursor TEXT NOT NULL,
  last_reconciled_at TEXT NOT NULL,
  status TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS feedback_event (
  event_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  reader_nonce TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  payload_json TEXT,
  payload_hash TEXT,
  created_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS preference_profile (
  profile_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS generation_request (
  request_id TEXT PRIMARY KEY,
  reader_nonce TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  package_id TEXT,
  dedupe_key TEXT,
  prompt TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
      `CREATE TABLE IF NOT EXISTS control_intent_event (
  event_id TEXT PRIMARY KEY,
  reader_nonce TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  intent_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  payload_hash TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
)`,
    ],
  },
];

export const FEED_V1_APP_SCHEMA: FeedV1AppSchema = {
  namespace: "xyz.tinycloud.feed.v1",
  resources: {
    sql: [
      {
        name: "artifacts_index",
        engine: "sqlite",
        schema: "schemas/artifacts-index.sql",
        description: "Artifacts truth index, package state, run ledger, source refs, spend ledger, and worker lock.",
        capabilities: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"],
        migrations: FEED_V1_ARTIFACTS_MIGRATIONS,
        sensitivity: "derived",
      },
      {
        name: "feed_index",
        engine: "sqlite",
        schema: "schemas/feed-index.sql",
        description: "Feed projection, feedback, preferences, generation requests, and control intents.",
        capabilities: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"],
        migrations: FEED_V1_FEED_MIGRATIONS,
        sensitivity: "derived",
      },
    ],
  },
};

export type MigrationApplyPlan = {
  namespace: string;
  dbName: FeedV1SqlResourceName;
  migrations: FeedV1SchemaMigration[];
};

export function feedV1MigrationApplyPlans(schema: FeedV1AppSchema = FEED_V1_APP_SCHEMA): MigrationApplyPlan[] {
  return schema.resources.sql.map((resource) => ({
    namespace: `${schema.namespace}.${resource.name}`,
    dbName: resource.name,
    migrations: resource.migrations,
  }));
}

export function assertFeedV1SchemaUsesMigrations(schema: FeedV1AppSchema = FEED_V1_APP_SCHEMA): void {
  for (const resource of schema.resources.sql) {
    if (!resource.capabilities.includes("tinycloud.sql/schema")) {
      throw new Error(`${resource.name}: schema resources must request tinycloud.sql/schema`);
    }
    if (resource.migrations.length === 0) {
      throw new Error(`${resource.name}: schema resource must declare migrations`);
    }
    for (const migration of resource.migrations) {
      if (!migration.id || migration.sql.length === 0) {
        throw new Error(`${resource.name}: migration must have id and sql`);
      }
    }
  }
}
