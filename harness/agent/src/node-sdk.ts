// node-sdk.ts — resolve + re-export the @tinycloud/node-sdk handles the agent
// backend needs (useDelegation / deserializeDelegation / PrivateKeySigner /
// TinyCloudNode).
//
// The agent owns an explicit package dependency on @tinycloud/node-sdk so local
// development does not depend on whatever global/local js-sdk checkout happens
// to exist on the machine. NODE_SDK_DIST remains as an escape hatch for testing a
// built GitHub checkout. The old absolute path fallback is retained only for
// legacy machines that still have the historical tinycloud-dev layout.

import { existsSync } from "node:fs";

// The built node-sdk the primary checkout's `tc-local` already uses. Same
// machine-specific anchor convention as tc.ts's DEFAULT_TC_LOCAL.
const DEFAULT_NODE_SDK_DIST =
  "/Users/samgbafa/Documents/github/tinycloud-dev/repositories/js-sdk/packages/node-sdk/dist/index.js";

function resolveNodeSdkPath(): string {
  const override = process.env.NODE_SDK_DIST?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`NODE_SDK_DIST does not exist: ${override}`);
    }
    return override;
  }
  if (existsSync(DEFAULT_NODE_SDK_DIST)) return DEFAULT_NODE_SDK_DIST;
  throw new Error(
    `@tinycloud/node-sdk dist not found at ${DEFAULT_NODE_SDK_DIST}. ` +
      `Build it (bun run --cwd packages/node-sdk build in the js-sdk checkout) ` +
      `or set NODE_SDK_DIST to a built dist/index.js.`,
  );
}

// A late, dynamic import so env overrides run at call time. The returned module
// is the node-sdk's full ESM surface; callers destructure the handles they need.
export async function loadNodeSdk(): Promise<typeof import("@tinycloud/node-sdk")> {
  const override = process.env.NODE_SDK_DIST?.trim();
  if (override) {
    const path = resolveNodeSdkPath();
    return (await import(path)) as typeof import("@tinycloud/node-sdk");
  }
  try {
    return (await import("@tinycloud/node-sdk")) as typeof import("@tinycloud/node-sdk");
  } catch (err) {
    if (existsSync(DEFAULT_NODE_SDK_DIST)) {
      return (await import(DEFAULT_NODE_SDK_DIST)) as typeof import("@tinycloud/node-sdk");
    }
    throw new Error(
      `@tinycloud/node-sdk package import failed. Run 'bun install' in harness/agent ` +
        `or set NODE_SDK_DIST to a built dist/index.js. Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
}
