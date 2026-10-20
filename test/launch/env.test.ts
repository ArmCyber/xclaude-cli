import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyState } from "../../src/core/state.ts";
import { buildEnv, takeCredentialNotes } from "../../src/launch/env.ts";

describe("buildEnv", () => {
  it("sets the account's config dir and name, and drops the Keychain override", () => {
    const env = buildEnv({ PATH: "/bin", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/other", CLAUDE_CONFIG_DIR: "/stale", KEEP: "1", GONE: undefined }, { name: "acme", configDir: "/h/.xclaude/accounts/acme" });
    assert.deepEqual(env, { PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.xclaude/accounts/acme", KEEP: "1", XCLAUDE_ACCOUNT: "acme" });
  });

  it("unsets CLAUDE_CONFIG_DIR for the main identity", () => {
    const env = buildEnv({ CLAUDE_CONFIG_DIR: "/stale" }, { name: "main", configDir: null });
    assert.deepEqual(env, { XCLAUDE_ACCOUNT: "main" });
  });

  it("leaves a claude.ai login in the environment out of an account, and keeps other credentials", () => {
    const login = { CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "r", CLAUDE_CODE_OAUTH_SCOPES: "s" };
    const env = buildEnv({ ...login, ANTHROPIC_API_KEY: "k" }, { name: "acme", configDir: "/h/.xclaude/accounts/acme" });
    assert.deepEqual(env, { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/h/.xclaude/accounts/acme", XCLAUDE_ACCOUNT: "acme" });
  });

  it("keeps that login for the main identity, as plain claude would", () => {
    const env = buildEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, { name: "main", configDir: null });
    assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "t", XCLAUDE_ACCOUNT: "main" });
  });
});

describe("takeCredentialNotes", () => {
  it("says once per account and variable what's left out and what may stand in for the login", () => {
    const state = emptyState();
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", CLAUDE_CODE_USE_BEDROCK: "0", PATH: "/bin" };
    assert.deepEqual(takeCredentialNotes(state, "acme", env), [
      "xclaude: acme signs in with its own login, so CLAUDE_CODE_OAUTH_TOKEN from your shell is left out (plain claude still gets it)",
      "xclaude: ANTHROPIC_API_KEY is set in your shell, so Claude Code may use it instead of acme's own login (/status shows which)",
    ]);
    assert.deepEqual(state.credentialNoted, { acme: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] });
    assert.deepEqual(takeCredentialNotes(state, "acme", env), [], "said once");
    assert.equal(takeCredentialNotes(state, "other", env).length, 2, "per account");
    assert.deepEqual(takeCredentialNotes(state, "acme", { ...env, CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "r", CLAUDE_CODE_OAUTH_SCOPES: "s", ANTHROPIC_AUTH_TOKEN: "a", CLAUDE_CODE_USE_VERTEX: "1" }), [
      "xclaude: acme signs in with its own login, so CLAUDE_CODE_OAUTH_REFRESH_TOKEN and CLAUDE_CODE_OAUTH_SCOPES from your shell are left out (plain claude still gets them)",
      "xclaude: ANTHROPIC_AUTH_TOKEN and CLAUDE_CODE_USE_VERTEX are set in your shell, so Claude Code may use them instead of acme's own login (/status shows which)",
    ], "only what's new");
  });

  it("says nothing when the shell holds no credentials", () => {
    const state = emptyState();
    assert.deepEqual(takeCredentialNotes(state, "acme", { PATH: "/bin", ANTHROPIC_API_KEY: "", CLAUDE_CODE_USE_FOUNDRY: "false" }), []);
    assert.deepEqual(state.credentialNoted, {});
  });
});
