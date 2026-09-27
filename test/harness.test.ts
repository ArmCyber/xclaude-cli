// Checks the test harness itself: the clean environment and the fake claude.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fakeLogin, makeSandbox, type Sandbox } from "./helpers/sandbox.ts";

describe("sandbox", () => {
  let sb: Sandbox;
  before(() => {
    sb = makeSandbox();
  });
  after(() => sb.cleanup());

  it("builds the environment from an allowlist", () => {
    for (const leaky of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CONFIG_DIR", "TMUX", "ZDOTDIR", "BASH_ENV"]) {
      assert.equal(sb.env[leaky], undefined, leaky);
    }
    assert.ok(sb.env.HOME!.startsWith(sb.root));
    assert.ok(sb.env.XCLAUDE_HOME!.startsWith(sb.root));
    assert.equal(sb.env.PATH!.split(path.delimiter)[0], sb.bin);
  });

  it("runs the built xclaude", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const res = sb.run(["--version"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), pkg.version);
  });

  it("resolves claude to the fake", () => {
    const res = sb.spawn("claude", ["--version"]);
    assert.equal(res.stdout.trim(), "2.1.282 (Claude Code)");
  });
});

describe("fake claude", () => {
  let sb: Sandbox;
  before(() => {
    sb = makeSandbox();
  });
  after(() => sb.cleanup());

  it("records argv, environment and cwd", () => {
    const res = sb.spawn("claude", ["-c", "hello world"], { env: { XCLAUDE_ACCOUNT: "acme" }, cwd: sb.root });
    assert.equal(res.status, 0);
    const call = sb.fakeCalls().at(-1)!;
    assert.deepEqual(call.argv, ["-c", "hello world"]);
    assert.equal(call.env.XCLAUDE_ACCOUNT, "acme");
    assert.equal(call.cwd, sb.root);
  });

  it("prints the captured --help", () => {
    const res = sb.spawn("claude", ["--help"]);
    assert.match(res.stdout, /^Usage: claude \[options\] \[command\] \[prompt\]/);
    assert.match(res.stdout, /--add-dir <directories\.\.\.>/);
  });

  it("answers auth status per config dir", () => {
    const dir = path.join(sb.root, "acct");
    let res = sb.spawn("claude", ["auth", "status"], { env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(res.status, 1);
    assert.equal(JSON.parse(res.stdout).loggedIn, false);

    fakeLogin(dir, { email: "a@example.com", orgId: "org-a", orgName: "Org A" });
    res = sb.spawn("claude", ["auth", "status"], { env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(res.status, 0);
    const status = JSON.parse(res.stdout);
    assert.equal(status.email, "a@example.com");
    assert.equal(status.orgId, "org-a");
    assert.equal(status.configDirectory, dir);

    sb.spawn("claude", ["auth", "logout"], { env: { CLAUDE_CONFIG_DIR: dir } });
    res = sb.spawn("claude", ["auth", "status"], { env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(res.status, 1);
  });

  it("logs in on an interactive launch when asked to", () => {
    const dir = path.join(sb.root, "fresh");
    const login = JSON.stringify({ email: "b@example.com", orgId: "org-b" });
    sb.spawn("claude", [], { env: { CLAUDE_CONFIG_DIR: dir, FAKE_CLAUDE_LOGIN: login } });
    const res = sb.spawn("claude", ["auth", "status"], { env: { CLAUDE_CONFIG_DIR: dir } });
    assert.equal(JSON.parse(res.stdout).email, "b@example.com");
  });

  it("prints agents from a fixture and exits with the requested code", () => {
    const file = path.join(sb.root, "agents.json");
    fs.writeFileSync(file, JSON.stringify([{ cwd: "/x", kind: "interactive", startedAt: 1, pid: 42, status: "idle" }]));
    const res = sb.spawn("claude", ["agents", "--json"], { env: { FAKE_CLAUDE_AGENTS: file } });
    assert.equal(JSON.parse(res.stdout)[0].pid, 42);
    assert.equal(sb.spawn("claude", ["-p", "x"], { env: { FAKE_CLAUDE_EXIT: "3" } }).status, 3);
  });
});
