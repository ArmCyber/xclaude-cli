// The launch pipeline through the injected exec: argv[0] included,
// exact arguments and environment.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadState } from "../../src/core/state.ts";
import { main } from "../../src/main.ts";
import { testCtx, type TestCtx } from "../helpers/ctx.ts";

let ctx: TestCtx;
beforeEach(() => {
  ctx = testCtx({ env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/elsewhere", CLAUDE_CONFIG_DIR: "/stale", KEEP_ME: "1" } });
  ctx.setConfig((c) => {
    c.accounts.acme = { model: "opus", effort: "max", args: ["--add-dir", "/a", "/b", "--chrome"] };
    c.accounts.plain = { model: null, effort: null, args: [] };
  });
});
afterEach(() => ctx.cleanup());

const acmeDir = () => path.join(ctx.paths.xhome, "accounts", "acme");

describe("launch", () => {
  it("execs claude with argv[0], defaults, account args and the user's arguments", async () => {
    fs.mkdirSync(acmeDir(), { recursive: true });
    assert.equal(await main(["acme", "-c", "fix the bug"], ctx), 0);
    const [call] = ctx.execs;
    assert.equal(call!.file, ctx.claude);
    assert.deepEqual(call!.argv, [ctx.claude, "--add-dir=/a", "--add-dir=/b", "--chrome", "--model", "opus", "--effort", "max", "-c", "fix the bug"]);
  });

  it("sets the environment: config dir, account name, no Keychain override, everything else inherited", async () => {
    await main(["acme"], ctx);
    const env = ctx.execs[0]!.env;
    assert.equal(env.CLAUDE_CONFIG_DIR, acmeDir());
    assert.equal(env.XCLAUDE_ACCOUNT, "acme");
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
    assert.equal(env.KEEP_ME, "1");
  });

  it("lets the user's --model and --effort win", async () => {
    await main(["acme", "--model", "sonnet", "--effort=low"], ctx);
    assert.deepEqual(ctx.execs[0]!.argv.slice(1), ["--add-dir=/a", "--add-dir=/b", "--chrome", "--model", "sonnet", "--effort=low"]);
  });

  it("passes subcommands through untouched", async () => {
    await main(["acme", "auth", "status", "--text"], ctx);
    assert.deepEqual(ctx.execs[0]!.argv.slice(1), ["auth", "status", "--text"]);
    await main(["acme", "daemon", "stop", "--any"], ctx);
    assert.deepEqual(ctx.execs[1]!.argv.slice(1), ["daemon", "stop", "--any"]);
  });

  it("runs the link engine for accounts and records the directory", async () => {
    await main(["plain", "-c"], ctx);
    assert.deepEqual(ctx.execs[0]!.argv.slice(1), ["-c"]);
    const dir = path.join(ctx.paths.xhome, "accounts", "plain");
    assert.equal(fs.readlinkSync(path.join(dir, "projects")), path.join(ctx.paths.store, "projects"));
    const state = loadState(ctx.paths);
    assert.equal(state.lastAccountByDir[ctx.cwd], "plain");
    assert.equal(state.lastUsedAccount, "plain");
  });

  it("launches the main identity without CLAUDE_CONFIG_DIR and without touching links", async () => {
    ctx.setConfig((c) => {
      c.main.enabled = true;
      c.main.model = "haiku";
    });
    await main(["main", "-p", "hi"], ctx);
    const call = ctx.execs[0]!;
    assert.deepEqual(call.argv.slice(1), ["--model", "haiku", "-p", "hi"]);
    assert.equal(call.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(call.env.XCLAUDE_ACCOUNT, "main");
    assert.equal(fs.existsSync(ctx.paths.accounts), false);
    assert.equal(fs.existsSync(ctx.paths.store), false, "the link engine never runs for main");
  });

  it("reports link problems but still launches", async () => {
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.symlinkSync("/somewhere/else", path.join(acmeDir(), "skills"));
    await main(["acme"], ctx);
    assert.equal(ctx.execs.length, 1);
    assert.match(ctx.io.stderr, /xclaude: acme\/skills links to \/somewhere\/else, not ~\/\.claude\/skills; `xclaude doctor --fix` replaces the link/);
  });

  it("prints each unknown entry once", async () => {
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.mkdirSync(path.join(acmeDir(), "brand-new"));
    await main(["acme"], ctx);
    await main(["acme"], ctx);
    const notices = ctx.io.stderr.split("\n").filter((l) => l.includes('new Claude Code entry "brand-new"'));
    assert.equal(notices.length, 1);
    assert.deepEqual(loadState(ctx.paths).seenUnknownEntries, { acme: ["brand-new"] });
  });

  it("requires an account without a terminal", async () => {
    await assert.rejects(main([], ctx), /account required/);
    await assert.rejects(main(["-c"], ctx), /account required/);
  });

  it("launches even when the account's links can't be checked", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores permissions");
      return;
    }
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.chmodSync(acmeDir(), 0o000);
    try {
      assert.equal(await main(["acme"], ctx), 0);
    } finally {
      fs.chmodSync(acmeDir(), 0o700);
    }
    assert.equal(ctx.execs.length, 1);
    assert.match(ctx.io.stderr, /couldn't check acme's links \(.*\); launching anyway/);
  });

  it("launches after an update even when ~/.xclaude can't be written", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores permissions");
      return;
    }
    fs.mkdirSync(acmeDir(), { recursive: true });
    fs.mkdirSync(path.join(ctx.paths.xhome, "shell"), { recursive: true });
    fs.writeFileSync(ctx.paths.state, JSON.stringify({ installedVersion: "0.0.0-old" }));
    fs.chmodSync(ctx.paths.xhome, 0o555);
    try {
      assert.equal(await main(["acme", "-c"], ctx), 0);
    } finally {
      fs.chmodSync(ctx.paths.xhome, 0o755);
    }
    assert.equal(ctx.execs.length, 1);
  });
});

