// The built xclaude replacing itself with the fake claude.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.ts";
import { median, reportTiming } from "../helpers/timing.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
  fs.mkdirSync(sb.xhome, { recursive: true });
  fs.writeFileSync(
    path.join(sb.xhome, "config.json"),
    JSON.stringify({ accounts: { acme: { model: "opus", effort: "max", args: ["--add-dir", "/a", "/b"] }, other: {} } }),
  );
});
afterEach(() => sb.cleanup());

describe("launch, end to end", () => {
  it("execs claude with every argument intact", () => {
    const tricky = ["-p", "two words", "it's \"quoted\"", "$HOME", "semi;colon", "", "--", "--model"];
    const res = sb.run(["acme", ...tricky]);
    assert.equal(res.status, 0, res.stderr);
    const calls = sb.fakeCalls();
    assert.deepEqual(calls[0]!.argv, ["--help"], "account args need the parsed --help once");
    const call = calls.at(-1);
    assert.deepEqual(call!.argv, ["--add-dir=/a", "--add-dir=/b", "--model", "opus", "--effort", "max", ...tricky]);
    assert.equal(call!.env.CLAUDE_CONFIG_DIR, path.join(sb.xhome, "accounts", "acme"));
    assert.equal(call!.env.XCLAUDE_ACCOUNT, "acme");
  });

  it("passes --help after an account on to claude", () => {
    const res = sb.run(["acme", "--help"]);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(sb.fakeCalls().at(-1)!.argv, ["--add-dir=/a", "--add-dir=/b", "--model", "opus", "--effort", "max", "--help"]);
  });

  it("replaces the process (same pid) and passes the exit code through", () => {
    const res = sb.run(["other", "-p", "x"], { env: { FAKE_CLAUDE_EXIT: "5" } });
    assert.equal(res.status, 5);
    assert.equal(sb.fakeCalls().at(-1)!.pid, res.pid);
  });

  it("links the account on first launch", () => {
    sb.run(["other"]);
    const dir = path.join(sb.xhome, "accounts", "other");
    assert.equal(fs.readlinkSync(path.join(dir, "projects")), path.join(sb.store, "projects"));
    assert.equal(fs.readlinkSync(path.join(dir, "history.jsonl")), path.join(sb.store, "history.jsonl"));
  });

  it("drops an inherited CLAUDE_SECURESTORAGE_CONFIG_DIR", () => {
    sb.run(["other"], { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/somewhere" } });
    assert.equal(sb.fakeCalls()[0]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
  });

  it("uses the spawn fallback when switched on", () => {
    const res = sb.run(["other", "-p", "x"], { env: { XCLAUDE_SWITCHES: "spawnFallback=1", FAKE_CLAUDE_EXIT: "3" } });
    assert.equal(res.status, 3);
    assert.notEqual(sb.fakeCalls().at(-1)!.pid, res.pid, "a child process");
    assert.deepEqual(sb.fakeCalls()[0]!.argv, ["-p", "x"]);
  });

  it("explains a missing claude", () => {
    const res = sb.run(["other"], { env: { XCLAUDE_CLAUDE_PATH: undefined, PATH: `${path.dirname(process.execPath)}` } });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Claude Code isn't installed|isn't an executable file/);
  });

  it("adds little overhead before claude starts", (t) => {
    sb.run(["other"]); // first launch links the account
    const via: number[] = [];
    const direct: number[] = [];
    for (let i = 0; i < 7; i++) {
      via.push(sb.run(["other", "-p", "x"]).ms);
      direct.push(sb.spawn(path.join(sb.bin, "claude"), ["-p", "x"]).ms);
    }
    reportTiming(t, "launch overhead (xclaude → claude, median of 7)", median(via) - median(direct), 100);
  });
});
