import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KV_PUT_ARG_VALUE_MAX_BYTES,
  kvPutBytes,
  resolveTcProfileContext,
  resolveTcSpaceUri,
  shouldUseSdkKvPut,
} from "../skills/_shared/lib/tc.ts";

const savedEnv = {
  HOME: process.env.HOME,
  TC_BIN: process.env.TC_BIN,
  TC_PROFILE: process.env.TC_PROFILE,
  TC_HOST: process.env.TC_HOST,
};

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifactory-tc-kv-"));
  tmpRoots.push(dir);
  return dir;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tc kv media writes", () => {
  test("large base64 values bypass argv", () => {
    expect(shouldUseSdkKvPut("x".repeat(KV_PUT_ARG_VALUE_MAX_BYTES))).toBe(false);
    expect(shouldUseSdkKvPut("x".repeat(KV_PUT_ARG_VALUE_MAX_BYTES + 1))).toBe(true);
  });

  test("resolves delegated profile and named application space from HOME", () => {
    const home = tmpRoot();
    const profileDir = join(home, ".tinycloud", "profiles", "delegated");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(home, ".tinycloud", "config.json"), JSON.stringify({ defaultProfile: "delegated" }));
    writeFileSync(
      join(profileDir, "profile.json"),
      JSON.stringify({
        name: "delegated",
        host: "https://node.example",
        chainId: 1,
        authMethod: "openkey",
      }),
    );
    writeFileSync(
      join(profileDir, "session.json"),
      JSON.stringify({
        address: "0xAAbbCCDdEeFf0011223344556677889900AaBbCc",
        chainId: 1,
        delegationHeader: { Authorization: "Bearer test" },
        delegationCid: "bafy-test",
        spaceId: "tinycloud:pkh:eip155:1:0xaabbccddeeff0011223344556677889900aabbcc:applications",
      }),
    );

    process.env.HOME = home;
    const ctx = resolveTcProfileContext();
    expect(ctx.profileName).toBe("delegated");
    expect(ctx.host).toBe("https://node.example");
    expect(resolveTcSpaceUri("applications", ctx)).toBe(
      "tinycloud:pkh:eip155:1:0xaabbccddeeff0011223344556677889900aabbcc:applications",
    );
  });

  test("small byte payloads still use tc positional string values", async () => {
    const dir = tmpRoot();
    const fakeTc = join(dir, "tc-fake.mjs");
    const argvFile = join(dir, "argv.json");
    writeFileSync(
      fakeTc,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv));
const key = argv[argv.indexOf("put") + 1];
process.stdout.write(JSON.stringify({ key, written: true }));
`,
    );
    chmodSync(fakeTc, 0o755);
    process.env.TC_BIN = fakeTc;

    await expect(
      kvPutBytes("xyz.tinycloud.artifacts/media/a/hero.png", new TextEncoder().encode("hello"), {
        space: "applications",
      }),
    ).resolves.toEqual({
      key: "xyz.tinycloud.artifacts/media/a/hero.png.b64",
      written: true,
    });

    const argv = JSON.parse(await Bun.file(argvFile).text()) as string[];
    expect(argv).toEqual([
      "--json",
      "--quiet",
      "kv",
      "put",
      "xyz.tinycloud.artifacts/media/a/hero.png.b64",
      "aGVsbG8=",
      "--space",
      "applications",
    ]);
  });
});
