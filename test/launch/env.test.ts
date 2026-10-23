import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { resolvePaths } from "../../src/core/paths.ts";
import { emptyState } from "../../src/core/state.ts";
import { buildEnv, sharedMemoryDir, takeCredentialNotes } from "../../src/launch/env.ts";
import { shareTable } from "../../src/link/table.ts";
import { SWITCHES } from "../../src/switches.ts";

describe("buildEnv", () => {
  it("sets the account's config dir and name, and drops the Keychain override", () => {
    const env = buildEnv(
      { PATH: "/bin", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/other", CLAUDE_CONFIG_DIR: "/stale", KEEP: "1", GONE: undefined },
      { name: "acme", configDir: "/h/.xclaude/accounts/acme", memoryDir: null },
    );
    assert.deepEqual(env, { PATH: "/bin", CLAUDE_CONFIG_DIR: "/h/.xclaude/accounts/acme", KEEP: "1", XCLAUDE_ACCOUNT: "acme" });
  });

  it("unsets CLAUDE_CONFIG_DIR for the main identity", () => {
    const env = buildEnv({ CLAUDE_CONFIG_DIR: "/stale" }, { name: "main", configDir: null, memoryDir: null });
    assert.deepEqual(env, { XCLAUDE_ACCOUNT: "main" });
  });

  it("leaves a claude.ai login in the environment out of an account, and keeps other credentials", () => {
    const login = { CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3", CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "r", CLAUDE_CODE_OAUTH_SCOPES: "s" };
    const env = buildEnv({ ...login, ANTHROPIC_API_KEY: "k" }, { name: "acme", configDir: "/h/.xclaude/accounts/acme", memoryDir: null });
    assert.deepEqual(env, { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/h/.xclaude/accounts/acme", XCLAUDE_ACCOUNT: "acme" });
  });

  it("keeps that login for the main identity, as plain claude would", () => {
    const env = buildEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, { name: "main", configDir: null, memoryDir: null });
    assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "t", XCLAUDE_ACCOUNT: "main" });
  });

  it("keeps an account's memory in ~/.claude, unless the shell names a folder", () => {
    const acme = { name: "acme", configDir: "/h/.xclaude/accounts/acme", memoryDir: "/h/.claude" };
    assert.deepEqual(buildEnv({}, acme), { CLAUDE_CONFIG_DIR: "/h/.xclaude/accounts/acme", CLAUDE_CODE_REMOTE_MEMORY_DIR: "/h/.claude", XCLAUDE_ACCOUNT: "acme" });
    assert.equal(buildEnv({ CLAUDE_CODE_REMOTE_MEMORY_DIR: "" }, acme).CLAUDE_CODE_REMOTE_MEMORY_DIR, "/h/.claude", "an empty value names nothing");
    assert.equal(buildEnv({ CLAUDE_CODE_REMOTE_MEMORY_DIR: "/mine" }, acme).CLAUDE_CODE_REMOTE_MEMORY_DIR, "/mine", "plain claude uses that folder too");
    assert.equal(buildEnv({}, { ...acme, memoryDir: null }).CLAUDE_CODE_REMOTE_MEMORY_DIR, undefined);
  });

  it("drops from the main identity the memory folder an account session passes on, and keeps the shell's", () => {
    const main = { name: "main", configDir: null, memoryDir: "/h/.claude" };
    assert.deepEqual(buildEnv({ CLAUDE_CODE_REMOTE_MEMORY_DIR: "/h/.claude", CLAUDE_CONFIG_DIR: "/h/.xclaude/accounts/acme" }, main), { XCLAUDE_ACCOUNT: "main" });
    assert.equal(buildEnv({ CLAUDE_CODE_REMOTE_MEMORY_DIR: "/mine" }, main).CLAUDE_CODE_REMOTE_MEMORY_DIR, "/mine");
  });
});

describe("sharedMemoryDir", () => {
  it("is ~/.claude while projects and agent-memory are shared and memoryInStore is on", () => {
    const paths = resolvePaths({ HOME: "/h" });
    const table = (remove: string[]) => shareTable({ ...defaultConfig(), share: { add: [], remove } }, SWITCHES);
    assert.equal(sharedMemoryDir(paths, table([]), SWITCHES), "/h/.claude");
    assert.equal(sharedMemoryDir(paths, table(["projects"]), SWITCHES), null, "unshared, the account's memory stays its own");
    assert.equal(sharedMemoryDir(paths, table(["agent-memory"]), SWITCHES), null, "the folder holds memory: user subagents' memory too");
    assert.equal(sharedMemoryDir(paths, table([]), { ...SWITCHES, memoryInStore: false }), null);
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
