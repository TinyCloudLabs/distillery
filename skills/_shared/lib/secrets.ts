// Secret resolution for distillery skills.
//
// Fallback chain, in order:
//   1. TinyCloud secrets vault (secrets.tinycloud.xyz) — canonical key
//      "secrets/<NAME>" in the "secrets" space. Headless transport is
//      pending a parallel spike; see fetchFromVault below. The chain is
//      structured so landing the transport is a one-function swap.
//   2. Environment variables — the secret's own name plus any aliases
//      (GEMINI_API_KEY mirrors pulse-radio's resolveGeminiKey precedence:
//      GOOGLE_AI_API_KEY > GEMINI_API_KEY > GOOGLE_API_KEY).
//
// Skills call getSecret("GEMINI_API_KEY") and never care where it came from.

/** Vault key convention used by the TinyCloud Secret Manager. */
export function vaultKeyFor(name: string): string {
  return `secrets/${name}`;
}

/**
 * Env-var aliases checked (in order) for a given canonical secret name.
 * The canonical name itself is always checked; aliases listed here are
 * checked in the order given, BEFORE the canonical name when the alias
 * list explicitly includes it (as with GEMINI_API_KEY, where pulse-radio's
 * precedence puts GOOGLE_AI_API_KEY first).
 */
const ENV_ALIASES: Record<string, readonly string[]> = {
  GEMINI_API_KEY: ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

function envNamesFor(name: string): readonly string[] {
  return ENV_ALIASES[name] ?? [name];
}

/**
 * TODO(vault-spike): headless TinyCloud vault transport.
 *
 * A parallel spike (distillery-spike) is verifying headless access to the
 * TinyCloud secrets vault via the tc CLI / @tinycloud/node-sdk. Once it
 * lands, implement this function to unlock the vault and read
 * vaultKeyFor(name) from the "secrets" space — nothing else in this module
 * (or in any skill) needs to change.
 *
 * Returns undefined when the vault is unavailable or the key is absent, so
 * the chain falls through to env vars instead of failing hard.
 */
async function fetchFromVault(name: string): Promise<string | undefined> {
  void vaultKeyFor(name); // key convention, ready for the transport
  return undefined;
}

export interface GetSecretOptions {
  /** Skip the vault and only consult env vars (used by tests / offline). */
  envOnly?: boolean;
}

/**
 * Resolve a secret by canonical name through the fallback chain.
 * Throws with every attempted source listed when nothing resolves.
 */
export async function getSecret(
  name: string,
  opts: GetSecretOptions = {},
): Promise<string> {
  const attempted: string[] = [];

  if (!opts.envOnly) {
    attempted.push(`TinyCloud vault: ${vaultKeyFor(name)} (secrets space)`);
    try {
      const fromVault = await fetchFromVault(name);
      if (fromVault?.trim()) return fromVault.trim();
    } catch {
      // Vault errors must never block the env fallback.
    }
  }

  for (const envName of envNamesFor(name)) {
    attempted.push(`env: ${envName}`);
    const value = process.env[envName]?.trim();
    if (value) return value;
  }

  throw new Error(
    `Secret "${name}" not found. Attempted sources (in order):\n` +
      attempted.map((s) => `  - ${s}`).join("\n") +
      `\nFix: add it to the TinyCloud Secret Manager (secrets.tinycloud.xyz) ` +
      `as "${vaultKeyFor(name)}", or export one of the env vars above.`,
  );
}
