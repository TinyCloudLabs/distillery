import { describe, expect, test } from "bun:test";
import {
  assertFeedV1SchemaUsesMigrations,
  feedV1MigrationApplyPlans,
  FEED_V1_APP_SCHEMA,
} from "../skills/_shared/lib/feed-v1-schema.ts";
import {
  assertNotLegacyFeedShape,
  buildGreenfieldSeed,
  candidateToArtifact,
} from "../skills/_shared/lib/feed-v1-bootstrap.ts";
import {
  FEED_V1_PROVIDER_PROFILES,
  FEED_V1_SKILL_OPTIONS,
  validateFeedArtifact,
  validateSkillRunOutput,
  type CandidateArtifactEnvelope,
  type FeedArtifact,
  type FeedArtifactProjection,
  type FeedWorkflowPackage,
  type FeedWorkflowRun,
  type SkillRunOutput,
  type TranscriptSourceRef,
} from "../skills/_shared/lib/feed-v1.ts";

const now = "2026-06-28T12:00:00.000Z";

function source(): TranscriptSourceRef {
  return {
    sourceRefId: "src-1",
    sourceKind: "listen_conversation",
    sourceId: "listen-1",
    observedPath: "sql_transcript_text",
    observedHash: "sha256:source",
    observedAt: now,
  };
}

function pkg(): FeedWorkflowPackage {
  return {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "daily_digest",
    displayName: "Daily Digest",
    version: "0.1.0",
    digest: "sha256:pkg",
    manifestKey: "packages/daily_digest/manifest.json",
    workflowRef: "workflows/daily-digest.smithers.json",
    workflowDigest: "sha256:workflow",
    admissionState: "reviewed_first_party",
    disclosure: {
      userCopy: "Reads bounded Listen excerpts and writes private Feed artifacts.",
      credentialOwner: "feed_hosted",
      providerClass: "first_party",
      egressClass: "model_provider",
    },
  };
}

function artifact(): FeedArtifact {
  const p = pkg();
  return {
    schemaVersion: "feed.artifact.v1",
    artifactId: "artifact-1",
    artifactType: "daily_digest",
    renderShape: "longform",
    title: "Daily Digest",
    summary: "One grounded artifact.",
    body: { markdown: "A grounded digest." },
    sourceRefs: [source()],
    producedBy: {
      packageId: p.packageId,
      packageVersion: p.version,
      packageDigest: p.digest,
      runId: "run-1",
      runtimeClass: "feed_hosted",
      providerClass: "first_party",
      credentialOwner: "feed_hosted",
      egressClass: "model_provider",
      disclosure: p.disclosure,
    },
    freshness: { label: "fresh", asOf: now },
    idempotency: {
      sourceFingerprint: "sha256:source",
      artifactFingerprint: "sha256:artifact",
      dedupeKey: "daily_digest:sha256:source",
    },
    storage: { docKey: "artifacts/artifact-1.json" },
    createdAt: now,
    updatedAt: now,
  };
}

function run(): FeedWorkflowRun {
  return {
    schemaVersion: "feed.workflow_run.v1",
    runId: "run-1",
    packageId: "daily_digest",
    packageDigest: "sha256:pkg",
    status: "published",
    sourceRefs: [source()],
    publishedArtifactIds: ["artifact-1"],
    droppedCandidates: [],
    spend: { budgetId: "m0", amount: 0, currency: "USD" },
    startedAt: now,
    finishedAt: now,
  };
}

function projection(): FeedArtifactProjection {
  return {
    artifactId: "artifact-1",
    rankScore: 100,
    disposition: "default",
    visibility: "ranked",
    freshnessLabel: "fresh",
    reasonCodes: ["seed"],
    packageId: "daily_digest",
    sourceFingerprint: "sha256:source",
    publishedAt: now,
    updatedAt: now,
  };
}

describe("Feed v1 contracts", () => {
  test("validates a canonical FeedArtifact", () => {
    const result = validateFeedArtifact(artifact());
    expect(result.ok).toBe(true);
  });

  test("validates SkillRunOutput candidate envelopes", () => {
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-1",
      artifactType: "insight",
      renderShape: "short_form",
      title: "A sharp point",
      body: { text: "A sharp point." },
      sourceRefs: [source()],
      quality: { criticPass: true, quotesVerified: true },
      idempotency: {
        sourceFingerprint: "sha256:source",
        artifactFingerprint: "sha256:candidate",
        dedupeKey: "insight:sha256:source",
      },
      storage: { docKey: "scratch/c-1.json" },
    };
    const output: SkillRunOutput = {
      candidates: [candidate],
      trace: {
        procedureVersion: "0.1.0",
        modelCalls: 1,
        toolCalls: [],
        stageTrace: [],
        droppedCandidates: [],
      },
    };

    expect(validateSkillRunOutput(output).ok).toBe(true);
    expect(candidateToArtifact(candidate, artifact().producedBy, now).schemaVersion).toBe("feed.artifact.v1");
  });

  test("rejects legacy artifact/interactions rows as native v1 input", () => {
    expect(() => assertNotLegacyFeedShape({ raw_artifact: "{}", render_type: "tweet" })).toThrow(
      /legacy artifact/,
    );
    expect(() => assertNotLegacyFeedShape({ action: "more", artifact_id: "old" })).toThrow(
      /legacy artifact/,
    );
  });
});

describe("Feed v1 schema and bootstrap", () => {
  test("declares app-kit schema resources with migration apply plans", () => {
    assertFeedV1SchemaUsesMigrations();
    const plans = feedV1MigrationApplyPlans();
    expect(plans.map((plan) => plan.dbName)).toEqual(["artifacts_index", "feed_index"]);
    expect(plans[0]!.namespace).toBe("xyz.tinycloud.feed.v1.artifacts_index");
    expect(plans[0]!.migrations[0]!.sql.some((sql) => sql.includes("artifact_index"))).toBe(true);
    expect(plans[1]!.migrations[0]!.sql.some((sql) => sql.includes("feed_artifact_projection"))).toBe(true);
    expect(
      FEED_V1_APP_SCHEMA.resources.sql.every((resource) =>
        resource.capabilities.includes("tinycloud.sql/schema"),
      ),
    ).toBe(true);
    expect(
      plans.some((plan) =>
        plan.migrations.some((migration) =>
          migration.sql.some((sql) => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(sql)),
        ),
      ),
    ).toBe(false);
  });

  test("builds deterministic seed rows for package, run, artifact, and projection", () => {
    const seed = buildGreenfieldSeed({
      pkg: pkg(),
      run: run(),
      artifact: artifact(),
      projection: projection(),
    });

    expect(seed.artifacts.map((row) => row.table)).toEqual([
      "workflow_package_state",
      "workflow_run_index",
      "artifact_index",
    ]);
    expect(seed.feed.map((row) => row.table)).toEqual(["feed_artifact_projection"]);
    expect(seed.artifacts[2]!.values.dedupe_key).toBe("daily_digest:sha256:source");
  });
});

describe("Feed v1 provider and skill defaults", () => {
  test("starts hosted provider profiles with OpenAI and Phala", () => {
    expect(FEED_V1_PROVIDER_PROFILES.map((profile) => profile.providerId)).toEqual(["openai", "phala"]);
    expect(FEED_V1_PROVIDER_PROFILES.find((profile) => profile.providerId === "phala")?.verification).toBe(
      "phala_tdx",
    );
  });

  test("keeps outward and media-heavy Artifactory skills gated", () => {
    const byId = Object.fromEntries(FEED_V1_SKILL_OPTIONS.map((option) => [option.skillId, option]));
    expect(byId["extract-insights"]?.tier).toBe("default_internal");
    expect(byId["person-brief"]?.tier).toBe("on_demand");
    expect(byId["quote-card"]?.autoPublish).toBe(false);
    expect(byId["make-clip"]?.tier).toBe("budget_provider_gated");
  });
});
