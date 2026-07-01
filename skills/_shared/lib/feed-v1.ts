// Feed v1 contracts owned by Artifactory for M0.
//
// This module intentionally mirrors the handoff types in the Feed v1 spec
// without pulling in a schema dependency. Skill scripts and workers should be
// runnable by any Bun-capable agent with plain TypeScript.

export type IsoDateString = string;
export type HashString = string;

export type RenderShape = "short_form" | "longform" | "media";
export type RuntimeClass = "feed_hosted" | "hosted_private" | "local" | "stub";
export type ProviderClass = "first_party" | "user_byok" | "local" | "none";
export type CredentialMode = "feed_hosted" | "user_byok_api_key" | "user_oauth_token" | "none";
export type EgressClass = "none" | "model_provider" | "media_provider" | "tool_provider";
export type SpendClass = "none" | "model" | "media" | "tool";

export type ExternalRuntimeCapability = {
  kind: "model" | "media_generation" | "web_search" | "provider_tool";
  provider: string;
  credentialMode: CredentialMode;
  scopes: string[];
  spendClass: SpendClass;
  egressClass: EgressClass;
};

export type RuntimePolicy = {
  runtimeClass: RuntimeClass;
  providerClass: ProviderClass;
  credentialMode: CredentialMode;
  egressClass: EgressClass;
  allowedTools: string[];
  disallowedTools: string[];
  maxModelCalls: number;
  timeoutMs: number;
  maxOutputBytes: number;
  budgetId?: string;
  externalCapabilities?: ExternalRuntimeCapability[];
};

export type TranscriptSourceRef = {
  sourceRefId: string;
  sourceKind: "listen_conversation";
  sourceId: string;
  observedPath: "kv_transcript" | "sql_transcript_json" | "sql_transcript_text";
  observedHash: HashString;
  observedAt: IsoDateString;
  quoteLineRefs?: string[];
};

export type WorkflowDisclosure = {
  userCopy: string;
  credentialOwner: CredentialMode;
  providerClass: ProviderClass;
  egressClass: EgressClass;
};

export type FeedWorkflowPackage = {
  schemaVersion: "feed.workflow_package.v1";
  packageId: string;
  displayName: string;
  version: string;
  digest: HashString;
  manifestKey: string;
  workflowRef: string;
  workflowDigest: HashString;
  admissionState: "candidate" | "enabled_local" | "reviewed_first_party" | "blocked";
  disclosure: WorkflowDisclosure;
};

export type FeedArtifact = {
  schemaVersion: "feed.artifact.v1";
  artifactId: string;
  artifactType: string;
  renderShape: RenderShape;
  title: string;
  summary?: string;
  body: unknown;
  renderHints?: Record<string, unknown>;
  sourceRefs: TranscriptSourceRef[];
  parentArtifactRefs?: { artifactId: string; artifactType: string; observedHash?: HashString }[];
  producedBy: {
    packageId: string;
    packageVersion: string;
    packageDigest: string;
    runId: string;
    runtimeClass: RuntimeClass;
    providerClass: ProviderClass;
    credentialOwner: CredentialMode;
    egressClass: EgressClass;
    disclosure: WorkflowDisclosure;
  };
  freshness: {
    label: "fresh" | "as_of" | "stale" | "source_unavailable" | "source_revoked";
    asOf: IsoDateString;
    lastCheckedAt?: IsoDateString;
  };
  idempotency: {
    sourceFingerprint: HashString;
    artifactFingerprint: HashString;
    dedupeKey: HashString;
  };
  storage: {
    docKey: string;
    mediaKeys?: string[];
  };
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

export type FeedArtifactProjection = {
  artifactId: string;
  rankScore: number;
  disposition: "default" | "saved" | "hidden";
  visibility: "ranked" | "deferred" | "capped" | "hidden" | "repair_only";
  freshnessLabel: FeedArtifact["freshness"]["label"];
  reasonCodes: string[];
  packageId: string;
  sourceFingerprint: HashString;
  publishedAt: IsoDateString;
  updatedAt: IsoDateString;
};

export type FeedbackEvent = {
  eventId: string;
  artifactId: string;
  actorId: string;
  readerNonce: string;
  signal: "save" | "unsave" | "hide" | "unhide" | "helpful" | "unhelpful" | "show_fewer" | "text_note";
  payload?: unknown;
  payloadHash?: HashString;
  createdAt: IsoDateString;
};

export type GenerationRequest = {
  requestId: string;
  actorId: string;
  readerNonce: string;
  status: "accepted" | "pending" | "blocked" | "rejected" | "consumed" | "expired";
  scope: { artifactType?: string; packageId?: string; sourceRefId?: string };
  prompt?: string;
  dedupeKey?: HashString;
  expiresAt: IsoDateString;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
};

export type ControlIntentEvent = {
  eventId: string;
  actorId: string;
  readerNonce: string;
  intentKind: "enable_package" | "pause_package" | "disable_package" | "tune_package" | "reset_package" | "ask_feed";
  status: "accepted" | "pending" | "blocked" | "rejected" | "consumed";
  targetRef: string;
  payload?: unknown;
  payloadHash?: HashString;
  createdAt: IsoDateString;
};

export type FeedWorkflowRun = {
  schemaVersion: "feed.workflow_run.v1";
  runId: string;
  packageId: string;
  packageDigest: HashString;
  status:
    | "queued"
    | "running"
    | "validating"
    | "published"
    | "zero_artifacts"
    | "blocked_authority"
    | "blocked_secret"
    | "blocked_budget"
    | "failed_runtime"
    | "failed_validation"
    | "cancelled"
    | "stale";
  sourceRefs: TranscriptSourceRef[];
  publishedArtifactIds: string[];
  droppedCandidates: { reason: string; title?: string; localCandidateId?: string }[];
  spend: { budgetId?: string; amount?: number; currency?: string };
  error?: { code: string; message: string };
  startedAt: IsoDateString;
  finishedAt?: IsoDateString;
};

export type ArtifactorySkillManifest = {
  schemaVersion: "feed.skill_manifest.v1";
  packageId: string;
  displayName: string;
  version: string;
  digest: HashString;
  source: "first_party" | "user_local" | "generated" | "imported";
  tier: 1 | 2;
  admissionState: FeedWorkflowPackage["admissionState"];
  artifactTypes: string[];
  renderShapes: RenderShape[];
  outputSchemaRef: string;
  settingsSchemaRef?: string;
  validatorRefs: string[];
  evaluatorRefs: string[];
  workflowRef: string;
  workflowDigest: HashString;
  workflowExecutor: "smithers" | "stub";
  stageCapabilities: {
    stageId: string;
    capabilities: string[];
    authority: "none" | "worker_run_stage_scope";
    egressClass?: EgressClass;
    spendClass?: SpendClass;
  }[];
  runtimePolicy: RuntimePolicy;
  limits: {
    maxAcceptedArtifacts: number;
    timeoutMs: number;
    maxOutputBytes: number;
    maxModelCalls: number;
    maxSourceRefs: number;
    maxInputTokens: number;
  };
  disclosure: WorkflowDisclosure;
};

export type ArtifactInputRef = {
  artifactId: string;
  artifactType: string;
  observedHash?: HashString;
};

export type SkillRunInput = {
  runId: string;
  skillManifest: ArtifactorySkillManifest;
  sourcePack: {
    refs: TranscriptSourceRef[];
    excerpts: { sourceRefId: string; text: string; quoteLineRefs?: string[] }[];
    maxInputTokens: number;
  };
  artifactPack?: {
    refs: ArtifactInputRef[];
    artifacts: {
      artifactId: string;
      artifactType: string;
      title: string;
      summary?: string;
      body: unknown;
      sourceRefs: TranscriptSourceRef[];
      producedBy: FeedArtifact["producedBy"];
    }[];
    maxInputTokens: number;
  };
  settings: unknown;
  runtimePolicy: RuntimePolicy;
  secretEnv?: {
    name: string;
    injection: "env";
    stageId: string;
    source: "worker_injected";
  }[];
  priorContext?: {
    recentArtifacts?: Pick<FeedArtifact, "artifactId" | "artifactType" | "title" | "idempotency">[];
    generationRequests?: GenerationRequest[];
  };
};

export type CandidateArtifactEnvelope = {
  schemaVersion: "feed.candidate_artifact.v1";
  localCandidateId: string;
  artifactType: string;
  renderShape: FeedArtifact["renderShape"];
  title: string;
  summary?: string;
  body: unknown;
  renderHints?: FeedArtifact["renderHints"];
  sourceRefs: TranscriptSourceRef[];
  parentArtifactRefs?: ArtifactInputRef[];
  sourceQuotes?: { quote: string; sourceRefId: string; loc?: string }[];
  quality: {
    criticPass: boolean;
    quotesVerified: boolean;
  };
  idempotency: FeedArtifact["idempotency"];
  storage: FeedArtifact["storage"];
};

export type SkillRunTrace = {
  procedureVersion: string;
  modelCalls: number;
  toolCalls: { name: string; purpose: string }[];
  stageTrace: {
    stageId: string;
    declaredCapabilities: string[];
    grantedCapabilities: string[];
    authorityUsed: boolean;
    deniedReasons: string[];
  }[];
  droppedCandidates: { reason: string; title?: string; localCandidateId?: string }[];
};

export type SkillRunOutput = {
  candidates: CandidateArtifactEnvelope[];
  trace: SkillRunTrace;
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type FieldType = "string" | "number" | "boolean" | "array" | "object";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function addRequired(errors: string[], value: Record<string, unknown>, path: string, type: FieldType): void {
  const v = value[path];
  if (type === "array") {
    if (!Array.isArray(v)) errors.push(`${path}: required array`);
    return;
  }
  if (type === "object") {
    if (record(v) === null) errors.push(`${path}: required object`);
    return;
  }
  if (typeof v !== type) errors.push(`${path}: required ${type}`);
}

function addIso(errors: string[], value: unknown, path: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${path}: required ISO date string`);
  }
}

function requireSchema<T>(value: unknown, schemaVersion: string, fields: Array<[string, FieldType]>): ValidationResult<T> {
  const obj = record(value);
  if (!obj) return { ok: false, errors: ["value must be an object"] };
  const errors: string[] = [];
  if (obj.schemaVersion !== schemaVersion) errors.push(`schemaVersion: must be ${schemaVersion}`);
  for (const [field, type] of fields) addRequired(errors, obj, field, type);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: obj as T };
}

export function validateTranscriptSourceRef(value: unknown): ValidationResult<TranscriptSourceRef> {
  const obj = record(value);
  if (!obj) return { ok: false, errors: ["source ref must be an object"] };
  const errors: string[] = [];
  for (const field of ["sourceRefId", "sourceKind", "sourceId", "observedPath", "observedHash"]) {
    addRequired(errors, obj, field, "string");
  }
  if (obj.sourceKind !== "listen_conversation") errors.push("sourceKind: must be listen_conversation");
  if (!["kv_transcript", "sql_transcript_json", "sql_transcript_text"].includes(String(obj.observedPath))) {
    errors.push("observedPath: invalid transcript path kind");
  }
  addIso(errors, obj.observedAt, "observedAt");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: obj as TranscriptSourceRef };
}

export function validateFeedArtifact(value: unknown): ValidationResult<FeedArtifact> {
  const result = requireSchema<FeedArtifact>(value, "feed.artifact.v1", [
    ["artifactId", "string"],
    ["artifactType", "string"],
    ["renderShape", "string"],
    ["title", "string"],
    ["sourceRefs", "array"],
    ["producedBy", "object"],
    ["freshness", "object"],
    ["idempotency", "object"],
    ["storage", "object"],
    ["createdAt", "string"],
    ["updatedAt", "string"],
  ]);
  if (!result.ok) return result;
  const errors: string[] = [];
  if (!["short_form", "longform", "media"].includes(result.value.renderShape)) {
    errors.push("renderShape: invalid render shape");
  }
  if (result.value.sourceRefs.length === 0) errors.push("sourceRefs: required non-empty array");
  result.value.sourceRefs.forEach((source, i) => {
    const sourceResult = validateTranscriptSourceRef(source);
    if (!sourceResult.ok) errors.push(...sourceResult.errors.map((e) => `sourceRefs[${i}].${e}`));
  });
  addIso(errors, result.value.createdAt, "createdAt");
  addIso(errors, result.value.updatedAt, "updatedAt");
  addIso(errors, result.value.freshness.asOf, "freshness.asOf");
  for (const field of ["sourceFingerprint", "artifactFingerprint", "dedupeKey"] as const) {
    if (!result.value.idempotency[field]) errors.push(`idempotency.${field}: required string`);
  }
  if (!result.value.storage.docKey) errors.push("storage.docKey: required string");
  return errors.length > 0 ? { ok: false, errors } : result;
}

export function validateCandidateArtifactEnvelope(value: unknown): ValidationResult<CandidateArtifactEnvelope> {
  const result = requireSchema<CandidateArtifactEnvelope>(value, "feed.candidate_artifact.v1", [
    ["localCandidateId", "string"],
    ["artifactType", "string"],
    ["renderShape", "string"],
    ["title", "string"],
    ["sourceRefs", "array"],
    ["quality", "object"],
    ["idempotency", "object"],
    ["storage", "object"],
  ]);
  if (!result.ok) return result;
  const errors: string[] = [];
  if (result.value.sourceRefs.length === 0) errors.push("sourceRefs: required non-empty array");
  if (typeof result.value.quality.criticPass !== "boolean") errors.push("quality.criticPass: required boolean");
  if (typeof result.value.quality.quotesVerified !== "boolean") errors.push("quality.quotesVerified: required boolean");
  if (!result.value.storage.docKey) errors.push("storage.docKey: required string");
  return errors.length > 0 ? { ok: false, errors } : result;
}

export function validateSkillRunOutput(value: unknown): ValidationResult<SkillRunOutput> {
  const obj = record(value);
  if (!obj) return { ok: false, errors: ["skill run output must be an object"] };
  const errors: string[] = [];
  if (!Array.isArray(obj.candidates)) errors.push("candidates: required array");
  if (record(obj.trace) === null) errors.push("trace: required object");
  if (Array.isArray(obj.candidates)) {
    obj.candidates.forEach((candidate, i) => {
      const result = validateCandidateArtifactEnvelope(candidate);
      if (!result.ok) errors.push(...result.errors.map((e) => `candidates[${i}].${e}`));
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: obj as SkillRunOutput };
}

export type FeedV1ProviderProfile = {
  providerId: "openai" | "phala";
  displayName: string;
  credentialMode: "feed_hosted";
  providerClass: "first_party";
  defaultEgressClass: "model_provider";
  secretRefs: string[];
  defaultModel: string;
  verification: "none" | "phala_tdx";
};

export const FEED_V1_PROVIDER_PROFILES: FeedV1ProviderProfile[] = [
  {
    providerId: "openai",
    displayName: "OpenAI",
    credentialMode: "feed_hosted",
    providerClass: "first_party",
    defaultEgressClass: "model_provider",
    secretRefs: ["secrets/feed/providers/openai/api_key"],
    defaultModel: "openai/gpt-5-mini",
    verification: "none",
  },
  {
    providerId: "phala",
    displayName: "Phala",
    credentialMode: "feed_hosted",
    providerClass: "first_party",
    defaultEgressClass: "model_provider",
    secretRefs: ["secrets/feed/providers/phala/redpill_api_key"],
    defaultModel: "phala/gpt-oss-120b",
    verification: "phala_tdx",
  },
];

export type FeedV1SkillTier = "default_internal" | "on_demand" | "approval_gated" | "budget_provider_gated";

export type FeedV1SkillOption = {
  skillId: string;
  tier: FeedV1SkillTier;
  autoPublish: boolean;
};

export const FEED_V1_SKILL_OPTIONS: FeedV1SkillOption[] = [
  { skillId: "extract-insights", tier: "default_internal", autoPublish: true },
  { skillId: "hot-take", tier: "default_internal", autoPublish: true },
  { skillId: "write-digest", tier: "default_internal", autoPublish: true },
  { skillId: "plan-feed-mix", tier: "default_internal", autoPublish: true },
  { skillId: "tc-listen-read", tier: "default_internal", autoPublish: true },
  { skillId: "person-brief", tier: "on_demand", autoPublish: false },
  { skillId: "banger-extractor", tier: "approval_gated", autoPublish: false },
  { skillId: "investor-snippet", tier: "approval_gated", autoPublish: false },
  { skillId: "quote-card", tier: "approval_gated", autoPublish: false },
  { skillId: "write-article", tier: "budget_provider_gated", autoPublish: false },
  { skillId: "make-podcast", tier: "budget_provider_gated", autoPublish: false },
  { skillId: "illustrate-card", tier: "budget_provider_gated", autoPublish: false },
  { skillId: "make-cheap-video", tier: "budget_provider_gated", autoPublish: false },
  { skillId: "make-clip", tier: "budget_provider_gated", autoPublish: false },
];
