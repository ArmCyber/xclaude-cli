// xclaude tmux new, on the sandbox's private tmux server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseNew } from "../../src/commands/tmux.ts";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.ts";
import { needTmux, tmux, waitFor } from "../helpers/tmux.ts";

describe("parseNew", () => {
  it("takes xclaude's options right after the label, then the account, then Claude's arguments", () => {
    assert.deepEqual(parseNew(["api", "--dir", "/x", "--detach", "acme", "-c", "--dir", "y"]), {
      label: "api",
      dir: "/x",
      detach: true,
      empty: false,
      account: "acme",
      claudeArgs: ["-c", "--dir", "y"],
    });
    assert.deepEqual(parseNew(["api", "--dir=/x", "--empty"]), { label: "api", dir: "/x", detach: false, empty: true, account: null, claudeArgs: [] });
    assert.equal(parseNew(["api"]).account, null);
  });

  it("rejects bad labels and options", () => {
    assert.throws(() => parseNew([]), /usage: xclaude tmux new <label>/);
    assert.throws(() => parseNew(["-x"]), /usage/);
    assert.throws(() => parseNew(["has space"]), /isn't a valid label/);
    assert.throws(() => parseNew(["_api"]), /isn't a valid label/);
    assert.throws(() => parseNew(["a".repeat(65)]), /isn't a valid label/);
    assert.throws(() => parseNew(["api", "--bogus"]), /unknown option --bogus/);
    assert.throws(() => parseNew(["api", "--dir"]), /--dir needs a path/);
    assert.throws(() => parseNew(["api", "--empty", "acme"]), /--empty and an account don't go together/);
  });
});

describe("tmux new", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    fs.mkdirSync(sb.xhome, { recursive: true });
    fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify({ accounts: { acme: { model: "opus" }, beta: {} } }));
  });
  afterEach(() => sb.cleanup());

  const opt = (id: string, name: string) => tmux(sb, ["show-options", "-t", id, "-v", name]).stdout.trim();
  const sessionIds = () =>
    tmux(sb, ["list-sessions", "-F", "#{session_id} #{session_name}"])
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ") as [string, string]);
  const launched = () => sb.fakeCalls().filter((c) => c.argv[0] !== "--help");

  it("creates the session, marks it, and types the command into its shell", async (t) => {
    if (!needTmux(sb, t)) return;
    const work = path.join(sb.root, "work");
    fs.mkdirSync(work);
    const res = sb.run(["tmux", "new", "api", "--detach", "--dir", work, "acme", "-p", "two words", "x;"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /started tmux session "api"; attach with: xclaude tmux attach api/);
    const [[id, name]] = sessionIds() as [[string, string]];
    assert.equal(name, "xclaude-acme_api");
    assert.equal(opt(id, "@xclaude"), "1");
    assert.equal(opt(id, "@xclaude_label"), "api");
    assert.equal(opt(id, "@xclaude_account"), "acme");
    assert.equal(opt(id, "@xclaude_dir"), work);
    await waitFor(() => launched().length > 0, "claude to start in the session");
    const call = launched()[0]!;
    assert.deepEqual(call.argv, ["--model", "opus", "-p", "two words", "x;"]);
    assert.equal(call.env.XCLAUDE_ACCOUNT, "acme");
    assert.equal(call.cwd, work);
  });

  it("refuses a label used by another account's session", (t) => {
    if (!needTmux(sb, t)) return;
    sb.run(["tmux", "new", "api", "--detach", "acme"]);
    const res = sb.run(["tmux", "new", "api", "--detach", "beta"]);
    assert.equal(res.status, 1);
    assert.equal(res.stderr, `xclaude: "api" is running (acme, ~): xclaude tmux attach api, or kill it first\n`);
    assert.equal(sessionIds().length, 1);
  });

  it("allows a label that is a prefix of an existing one", (t) => {
    if (!needTmux(sb, t)) return;
    assert.equal(sb.run(["tmux", "new", "api2", "--detach", "acme"]).status, 0);
    assert.equal(sb.run(["tmux", "new", "api", "--detach", "acme"]).status, 0);
    assert.deepEqual(sessionIds().map(([, n]) => n).sort(), ["xclaude-acme_api", "xclaude-acme_api2"]);
  });

  it("handles a --dir ending in a semicolon", (t) => {
    if (!needTmux(sb, t)) return;
    const odd = path.join(sb.root, "odd;");
    fs.mkdirSync(odd);
    assert.equal(sb.run(["tmux", "new", "semi", "--detach", `--dir=${odd}`, "--empty"]).status, 0);
    const [[id]] = sessionIds() as [[string, string]];
    assert.equal(opt(id, "@xclaude_dir"), odd);
    assert.equal(tmux(sb, ["display-message", "-p", "-t", id, "#{pane_current_path}"]).stdout.trim(), odd);
  });

  it("starts the server without account or Claude-session variables", (t) => {
    if (!needTmux(sb, t)) return;
    const res = sb.run(["tmux", "new", "clean", "--detach", "--empty"], {
      env: { CLAUDE_CONFIG_DIR: "/x", XCLAUDE_ACCOUNT: "acme", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/y", CLAUDECODE: "1" },
    });
    assert.equal(res.status, 0, res.stderr);
    const global = tmux(sb, ["show-environment", "-g"]).stdout;
    for (const v of ["CLAUDE_CONFIG_DIR", "XCLAUDE_ACCOUNT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDECODE"]) {
      assert.doesNotMatch(global, new RegExp(`^${v}=`, "m"), v);
    }
    assert.match(global, /^HOME=/m);
  });

  it("never adopts a foreign session with the same name", (t) => {
    if (!needTmux(sb, t)) return;
    tmux(sb, ["new-session", "-d", "-s", "xclaude-acme_api"]);
    const res = sb.run(["tmux", "new", "api", "--detach", "acme"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /a tmux session named "xclaude-acme_api" exists but isn't xclaude's/);
    assert.equal(sessionIds().length, 1);
  });

  it("makes an empty session without typing anything", async (t) => {
    if (!needTmux(sb, t)) return;
    assert.equal(sb.run(["tmux", "new", "shell", "--detach", "--empty"]).status, 0);
    const [[id, name]] = sessionIds() as [[string, string]];
    assert.equal(name, "xclaude--shell");
    assert.equal(opt(id, "@xclaude_account"), "");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(launched().length, 0);
  });

  it("needs an account (or --empty) without a terminal, and a known account", (t) => {
    if (!needTmux(sb, t)) return;
    let res = sb.run(["tmux", "new", "api", "--detach"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /account required/);
    res = sb.run(["tmux", "new", "api", "--detach", "nobody"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown account or command "nobody"/);
    assert.equal(sessionIds().length, 0);
  });

  it("shows the account in the session's status bar", (t) => {
    if (!needTmux(sb, t)) return;
    sb.run(["tmux", "new", "api", "--detach", "acme"]);
    const [[id]] = sessionIds() as [[string, string]];
    const global = tmux(sb, ["show-options", "-gv", "status-right"]).stdout.replace(/\n$/, "");
    const globalLength = Number(tmux(sb, ["show-options", "-gv", "status-right-length"]).stdout.trim());
    assert.equal(tmux(sb, ["show-options", "-t", id, "-v", "status-right"]).stdout.replace(/\n$/, ""), `[acme] ${global}`);
    assert.equal(Number(opt(id, "status-right-length")), globalLength + "[acme] ".length);
    assert.equal(tmux(sb, ["display-message", "-p", "-t", id, "#{@xclaude_account}"]).stdout.trim(), "acme");
  });

  it("leaves the status bar alone when tmux.statusRight is false, and for --empty", (t) => {
    if (!needTmux(sb, t)) return;
    fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify({ accounts: { acme: {} }, tmux: { statusRight: false } }));
    sb.run(["tmux", "new", "api", "--detach", "acme"]);
    sb.run(["tmux", "new", "sh", "--detach", "--empty"]);
    for (const [id] of sessionIds()) assert.equal(opt(id, "status-right"), "", "no session-level override");
  });
});

