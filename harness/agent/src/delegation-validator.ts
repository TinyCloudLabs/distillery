// delegation-validator.ts — gate an incoming PortableDelegation BEFORE the agent
// activates it (node.useDelegation) or persists it to disk. useDelegation in
// wallet mode does NOT check the audience or scopes itself, so a forged/over-
// broad delegation would otherwise be ACTIVATED before we could reject it. This
// is the agent's trust boundary: every check here must pass or we throw (the
// server maps the throw to HTTP 400 with the message).
//
// Split into two phases so we NEVER call useDelegation on an unvalidated grant:
//
//   validateDelegationPreActivation(delegation, ctx)  — runs BEFORE useDelegation
//     1. chainId is the agent's expected numeric chain.
//     2. expiry is a real future Date.
//     3. spaceId is a well-formed tinycloud:pkh space URI.
//     4. the delegate/audience DID === THIS agent's did:pkh (no foreign audience).
//     5. the granted resources are a SUBSET of the advertised PERMISSIONS (no
//        scope escalation), and each resource targets THIS delegation's space.
//
//   validateRestorableSpace(delegation, restorable)   — runs AFTER useDelegation
//     6. restorable.spaceId === delegation.spaceId (the minted session targets
//        the same space the delegation claims). This is the only check that
//        needs the session, so it's the only thing deferred past useDelegation.
//
// The serialized-payload size cap is enforced in session.activate (before
// deserialize), since it bounds the parse, not the parsed object.

import type { PortableDelegation, PermissionEntry } from "@tinycloud/node-sdk";
import type { RestorableSession } from "./profile-writer.ts";

// The bare `@tinycloud/node-sdk` specifier resolves to the package's .d.ts at
// runtime (its dist has no package "main"), so VALUE helpers must come through
// the same dynamic resolver the rest of the backend uses — never a static
// value import. The caller injects them (it already has the loaded sdk module).
export interface CapabilityHelpers {
  isCapabilitySubset: (
    requested: readonly PermissionEntry[],
    granted: readonly PermissionEntry[],
  ) => { subset: boolean; missing: PermissionEntry[] };
  principalDidEquals: (a: string, b: string) => boolean;
}

/** What the pre-activation validator compares the delegation against. */
export interface ValidationContext {
  /** The agent's stable did:pkh (the only allowed audience). */
  agentDid: string;
  /** The chain the agent operates on; the delegation must match. */
  expectedChainId: number;
  /** The agent's advertised scopes (the upper bound on what may be granted). */
  permissions: readonly PermissionEntry[];
  /** SDK capability helpers (injected — see CapabilityHelpers above). */
  helpers: CapabilityHelpers;
}

/** Short tc service names → the long-form the manifest/subset check expects. */
const SERVICE_SHORT_TO_LONG: Readonly<Record<string, string>> = {
  kv: "tinycloud.kv",
  sql: "tinycloud.sql",
  duckdb: "tinycloud.duckdb",
  capabilities: "tinycloud.capabilities",
  hooks: "tinycloud.hooks",
  encryption: "tinycloud.encryption",
};

/** A tinycloud:pkh:eip155:<chain>:<addr>:<name> space URI (the only shape we grant on). */
const SPACE_URI_RE = /^tinycloud:pkh:eip155:\d+:0x[0-9a-fA-F]{40}:.+$/;

/**
 * Does a resource's `space` field refer to the SAME space as the delegation?
 *
 * SECURITY: a resource's space must not merely share the trailing NAME segment
 * — `tinycloud:...:OTHEROWNER:default` is a DIFFERENT owner's space than
 * `tinycloud:...:OUROWNER:default`. So:
 *  - if `resourceSpace` is a full pkh URI, require an EXACT match to the
 *    delegation's (already-validated) full pkh `spaceId`;
 *  - only when `resourceSpace` is a BARE short name (no `tinycloud:` prefix) do
 *    we accept it by matching the delegation's trailing name segment.
 */
function resourceTargetsDelegationSpace(resourceSpace: string, delegationSpaceId: string): boolean {
  if (resourceSpace.startsWith("tinycloud:")) {
    return resourceSpace === delegationSpaceId; // exact full-URI match — no owner spoof
  }
  // bare short name: compare against the delegation space's trailing segment.
  const lastColon = delegationSpaceId.lastIndexOf(":");
  const delegationName =
    lastColon === -1 || lastColon === delegationSpaceId.length - 1
      ? delegationSpaceId
      : delegationSpaceId.slice(lastColon + 1);
  return resourceSpace === delegationName;
}

/**
 * PRE-ACTIVATION checks: everything that can be decided from the delegation
 * alone, run BEFORE node.useDelegation so a forged/over-scoped grant is rejected
 * before it is ever activated. Throws (server → 400) on any failure.
 */
export function validateDelegationPreActivation(
  delegation: PortableDelegation,
  ctx: ValidationContext,
): void {
  // 1. chainId — numeric + the agent's expected chain.
  if (typeof delegation.chainId !== "number" || !Number.isFinite(delegation.chainId)) {
    throw new Error("invalid delegation: chainId is missing or non-numeric.");
  }
  if (delegation.chainId !== ctx.expectedChainId) {
    throw new Error(
      `invalid delegation: chainId ${delegation.chainId} != expected ${ctx.expectedChainId}.`,
    );
  }

  // 2. expiry — a real Date strictly in the future.
  const expiry = delegation.expiry;
  if (!(expiry instanceof Date) || Number.isNaN(expiry.getTime())) {
    throw new Error("invalid delegation: expiry is not a valid date.");
  }
  if (expiry.getTime() <= Date.now()) {
    throw new Error(`invalid delegation: already expired (${expiry.toISOString()}).`);
  }

  // 3. spaceId — well-formed pkh space URI.
  if (typeof delegation.spaceId !== "string" || !SPACE_URI_RE.test(delegation.spaceId)) {
    throw new Error(`invalid delegation: malformed spaceId '${delegation.spaceId}'.`);
  }

  // 4. audience — the delegate DID must be THIS agent's did:pkh.
  if (typeof delegation.delegateDID !== "string" || delegation.delegateDID.length === 0) {
    throw new Error("invalid delegation: missing delegateDID.");
  }
  if (!ctx.helpers.principalDidEquals(delegation.delegateDID, ctx.agentDid)) {
    throw new Error(
      `invalid delegation: audience '${delegation.delegateDID}' is not this agent ` +
        `('${ctx.agentDid}').`,
    );
  }

  // 5. scope subset — the granted resources must not exceed the advertised
  //    PERMISSIONS. We need the full per-resource breakdown to know the service
  //    of each grant; a legacy single-resource delegation (no `resources[]`)
  //    can't be scope-checked, so we reject it (this agent always issues the
  //    multi-resource shape).
  const resources = delegation.resources;
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error(
      "invalid delegation: no resources[] breakdown to scope-check (multi-resource " +
        "delegation required).",
    );
  }

  const granted: PermissionEntry[] = resources.map((r) => {
    const longService = SERVICE_SHORT_TO_LONG[r.service];
    if (!longService) {
      throw new Error(`invalid delegation: unknown service '${r.service}' in a resource.`);
    }
    // Every resource must target THIS delegation's space — a resource on any
    // other space (incl. a different owner's same-named space) is escalating.
    if (!resourceTargetsDelegationSpace(r.space, delegation.spaceId)) {
      throw new Error(
        `invalid delegation: resource space '${r.space}' != delegation space '${delegation.spaceId}'.`,
      );
    }
    // Pin BOTH sides to the delegation's full spaceId so the subset check
    // compares service/path/actions (space equality is already proven above).
    return { service: longService, space: delegation.spaceId, path: r.path, actions: r.actions };
  });

  const allowed: PermissionEntry[] = ctx.permissions.map((p) => ({
    service: p.service,
    space: delegation.spaceId,
    path: p.path,
    actions: [...p.actions],
  }));

  const { subset, missing } = ctx.helpers.isCapabilitySubset(granted, allowed);
  if (!subset) {
    const detail = missing
      .map((m) => `${m.service} ${m.path} [${m.actions.join(",")}]`)
      .join("; ");
    throw new Error(
      `invalid delegation: granted scopes exceed the agent's advertised permissions ` +
        `(escalation): ${detail}.`,
    );
  }
}

/**
 * POST-ACTIVATION check: the session minted by useDelegation must target the
 * SAME space the delegation claimed. Runs after useDelegation (it's the only
 * check that needs the restorable session). Throws (server → 400) on mismatch.
 */
export function validateRestorableSpace(
  delegation: PortableDelegation,
  restorable: RestorableSession,
): void {
  if (restorable.spaceId !== delegation.spaceId) {
    throw new Error(
      `invalid delegation: activated session space '${restorable.spaceId}' ` +
        `!= delegation space '${delegation.spaceId}'.`,
    );
  }
}
