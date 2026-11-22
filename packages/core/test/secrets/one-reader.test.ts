import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// The one-reader rule for secrets (spec §9.1, lane SF): on Windows and Linux MOSS's secrets are in the encrypted file, and
// the OS store holds only that file's key. A new `Bun.secrets` call anywhere else would put a secret back in the OS store
// (where the sandbox principal's tools, `gh` and the rest can reach it), or read one that is no longer there. So the places
// that name `Bun.secrets` as a value, and the SDK's keychain stores that read it themselves, are a short list; a file added
// to it is a decision, made here and reviewed.

const ROOT = join(import.meta.dir, "..", "..", "..", ".."); // the repository
const SOURCE_ROOTS = ["packages/core/src", "packages/cli/src", "packages/protocol/src", "packages/plugin-sdk/src", "apps", "plugins"];

/** Where `Bun.secrets` is used as a value, and why. */
const ALLOWED_BUN_SECRETS = new Map<string, string>([
  ["packages/core/src/auth/secret-store.ts", "`osSecretsBackend`: the raw OS store, which holds the secrets file's key and what the one-time move reads"],
  ["packages/core/src/auth/test-isolation.ts", "the test fence on `Bun.secrets` itself"],
]);

/** The SDK's own keychain stores, which read `Bun.secrets` inside the package: the daemon builds the one it uses only on macOS. */
const SDK_KEYCHAIN_STORES = ["createKeychainMcpOAuthStore", "createKeychainCredentialStore", "createKeychainSecretReader", "createKeychainRawStore"];
const ALLOWED_SDK_STORES = new Map<string, string>([
  ["packages/core/src/runtime-sdk/mcp-oauth-store.ts", "macOS only (`process.platform === \"darwin\"` or a test); Windows and Linux take the file backend"],
]);

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "generated" || name === "dist" || name === "test" || name === "tests") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  try { walk(dir); } catch { /* a root this checkout does not have */ }
  return out;
}

/** The code of a file: comments and the type position (`typeof Bun.secrets`) gone. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n").replace(/typeof\s+Bun\.secrets/g, "");
}

describe("who reads the OS secret store", () => {
  const files = SOURCE_ROOTS.flatMap((r) => sources(join(ROOT, r)));

  test("the source tree is found", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  test("Bun.secrets is a value only where the list says", () => {
    const found = files.filter((f) => /\bBun\??\.secrets\b/.test(code(readFileSync(f, "utf8")))).map((f) => relative(ROOT, f).split(sep).join("/")).sort();
    expect(found).toEqual([...ALLOWED_BUN_SECRETS.keys()].sort());
  });

  test("the SDK's keychain stores are built only where the list says", () => {
    const found = files.filter((f) => SDK_KEYCHAIN_STORES.some((n) => code(readFileSync(f, "utf8")).includes(n))).map((f) => relative(ROOT, f).split(sep).join("/")).sort();
    expect(found).toEqual([...ALLOWED_SDK_STORES.keys()].sort());
  });
});
