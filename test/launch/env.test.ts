import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEnv } from "../../src/launch/env.ts";

describe("buildEnv", () => {
  it("sets the account's config dir and name, and drops the Keychain override", () => {
    const env = buildEnv({ PATH: "/bin", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/other", CLAUDE_CONFIG_DIR: "/stale", KEEP: "1", GONE: undefined }, { name: "acme", configDir: "/h/.xclaude/accounts/acme" });
    assert.deepEqual(env, { PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.xclaude/accounts/acme", KEEP: "1", XCLAUDE_ACCOUNT: "acme" });
  });

  it("unsets CLAUDE_CONFIG_DIR for the main identity", () => {
    const env = buildEnv({ CLAUDE_CONFIG_DIR: "/stale" }, { name: "main", configDir: null });
    assert.deepEqual(env, { XCLAUDE_ACCOUNT: "main" });
  });
});
