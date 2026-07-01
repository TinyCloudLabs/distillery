import {
  type CandidateArtifactEnvelope,
  type FeedArtifact,
  type FeedArtifactProjection,
  type FeedWorkflowPackage,
  type FeedWorkflowRun,
  validateCandidateArtifactEnvelope,
  validateFeedArtifact,
} from "./feed-v1.ts";

export type SqlSeedRow = {
  table: string;
  values: Record<string, string | number | null>;
};

export type FeedV1Seed = {
  artifacts: SqlSeedRow[];
  feed: SqlSeedRow[];
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function legacyShape(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.raw_artifact !== undefined ||
    record.render_type !== undefined ||
    record.source_transcripts !== undefined ||
    record.artifact_id !== undefined ||
    record.action !== undefined
  );
}

export function assertNotLegacyFeedShape(value: unknown): void {
  if (legacyShape(value)) {
    throw new Error("legacy artifact/interactions shape is not accepted as native Feed v1 input");
  }
}

export function artifactIndexRow(artifact: FeedArtifact): SqlSeedRow {
  assertNotLegacyFeedShape(artifact);
  const validated = validateFeedArtifact(artifact);
  if (!validated.ok) throw new Error(`invalid FeedArtifact: ${validated.errors.join("; ")}`);
  return {
    table: "artifact_index",
    values: {
      artifact_id: artifact.artifactId,
      artifact_type: artifact.artifactType,
      package_id: artifact.producedBy.packageId,
      package_version: artifact.producedBy.packageVersion,
      package_digest: artifact.producedBy.packageDigest,
      run_id: artifact.producedBy.runId,
      source_fingerprint: artifact.idempotency.sourceFingerprint,
      artifact_fingerprint: artifact.idempotency.artifactFingerprint,
      dedupe_key: artifact.idempotency.dedupeKey,
      doc_key: artifact.storage.docKey,
      media_keys_json: json(artifact.storage.mediaKeys ?? []),
      created_at: artifact.createdAt,
      updated_at: artifact.updatedAt,
      published_at: artifact.createdAt,
    },
  };
}

export function projectionRow(projection: FeedArtifactProjection): SqlSeedRow {
  assertNotLegacyFeedShape(projection);
  return {
    table: "feed_artifact_projection",
    values: {
      artifact_id: projection.artifactId,
      rank_score: projection.rankScore,
      disposition: projection.disposition,
      visibility: projection.visibility,
      freshness_label: projection.freshnessLabel,
      reason_codes_json: json(projection.reasonCodes),
      package_id: projection.packageId,
      source_fingerprint: projection.sourceFingerprint,
      published_at: projection.publishedAt,
      updated_at: projection.updatedAt,
    },
  };
}

export function packageStateRow(pkg: FeedWorkflowPackage, updatedAt: string): SqlSeedRow {
  return {
    table: "workflow_package_state",
    values: {
      package_id: pkg.packageId,
      display_name: pkg.displayName,
      version: pkg.version,
      digest: pkg.digest,
      manifest_key: pkg.manifestKey,
      workflow_ref: pkg.workflowRef,
      workflow_digest: pkg.workflowDigest,
      admission_state: pkg.admissionState,
      disclosure_json: json(pkg.disclosure),
      enabled_at: pkg.admissionState === "enabled_local" || pkg.admissionState === "reviewed_first_party" ? updatedAt : null,
      paused_at: null,
      updated_at: updatedAt,
    },
  };
}

export function workflowRunRow(run: FeedWorkflowRun): SqlSeedRow {
  return {
    table: "workflow_run_index",
    values: {
      run_id: run.runId,
      package_id: run.packageId,
      package_digest: run.packageDigest,
      status: run.status,
      source_refs_json: json(run.sourceRefs),
      published_artifact_ids_json: json(run.publishedArtifactIds),
      dropped_candidates_json: json(run.droppedCandidates),
      spend_json: json(run.spend),
      error_json: run.error ? json(run.error) : null,
      started_at: run.startedAt,
      finished_at: run.finishedAt ?? null,
    },
  };
}

export function candidateToArtifact(
  candidate: CandidateArtifactEnvelope,
  producedBy: FeedArtifact["producedBy"],
  now: string,
): FeedArtifact {
  const result = validateCandidateArtifactEnvelope(candidate);
  if (!result.ok) throw new Error(`invalid candidate artifact: ${result.errors.join("; ")}`);
  return {
    schemaVersion: "feed.artifact.v1",
    artifactId: `${producedBy.runId}:${candidate.localCandidateId}`,
    artifactType: candidate.artifactType,
    renderShape: candidate.renderShape,
    title: candidate.title,
    summary: candidate.summary,
    body: candidate.body,
    renderHints: candidate.renderHints,
    sourceRefs: candidate.sourceRefs,
    parentArtifactRefs: candidate.parentArtifactRefs,
    producedBy,
    freshness: { label: "fresh", asOf: now },
    idempotency: candidate.idempotency,
    storage: candidate.storage,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildGreenfieldSeed(input: {
  pkg: FeedWorkflowPackage;
  run: FeedWorkflowRun;
  artifact: FeedArtifact;
  projection: FeedArtifactProjection;
}): FeedV1Seed {
  return {
    artifacts: [
      packageStateRow(input.pkg, input.artifact.updatedAt),
      workflowRunRow(input.run),
      artifactIndexRow(input.artifact),
    ],
    feed: [projectionRow(input.projection)],
  };
}
