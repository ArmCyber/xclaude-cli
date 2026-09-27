// tmux attach, ls and kill, plus rm's session listing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { formatCreated } from "../../src/commands/tmux.ts";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.ts";
import { needTmux, tmux, waitFor } from "../helpers/tmux.ts";

describe("formatCreated", () => {
  it("shows the time today and the date before", () => {
    const now = new Date(2026, 8, 26, 18, 0);
    assert.equal(formatCreated(new Date(2026, 8, 26, 14, 3).getTime() / 1000, now), "14:03");
    assert.equal(formatCreated(new Date(2026, 8, 25, 9, 7).getTime() / 1000, now), "2026-09-25 09:07");
  });
});

describe("tmux sessions", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    fs.mkdirSync(sb.xhome, { recursive: true });
    fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify({ accounts: { acme: {}, beta: {} } }));
  });
  afterEach(() => {
    tmux(sb, ["-L", "outer", "kill-server"]);
    sb.cleanup();
  });

  const outer = (args: string[]) => tmux(sb, ["-L", "outer", ...args]);
  const clientSessions = () =>
    tmux(sb, ["list-clients", "-F", "#{client_session}"])
      .stdout.trim()
      .split("\n")
      .filter(Boolean);

  it("lists sessions, and bare `xclaude tmux` does the same", (t) => {
    if (!needTmux(sb, t)) return;
    assert.equal(sb.run(["tmux", "ls"]).stdout, "No xclaude tmux sessions. Start one with: xclaude tmux new <label> [<account>]\n");
    const work = path.join(sb.home, "code", "api");
    fs.mkdirSync(work, { recursive: true });
    sb.run(["tmux", "new", "api", "--detach", "--dir", work, "acme"]);
    sb.run(["tmux", "new", "notes", "--detach", "--empty"]);
    tmux(sb, ["new-session", "-d", "-s", "not-ours"]);
    const out = sb.run(["tmux", "ls"]).stdout;
    const lines = out.trim().split("\n");
    assert.match(lines[0]!, /^LABEL\s+ACCOUNT\s+WORKDIR\s+ATTACHED\s+CREATED\s+CLAUDE$/);
    assert.match(lines[1]!, /^api\s+acme\s+~\/code\/api\s+no\s+\d\d:\d\d\s+–$/);
    assert.match(lines[2]!, /^notes\s+–\s+~\s+no\s+\d\d:\d\d\s+–$/);
    assert.equal(lines.length, 3, "sessions without @xclaude=1 aren't listed");
    assert.equal(sb.run(["tmux"]).stdout, out);
  });

  it("kills by label", (t) => {
    if (!needTmux(sb, t)) return;
    sb.run(["tmux", "new", "api", "--detach", "--empty"]);
    sb.run(["tmux", "new", "api2", "--detach", "--empty"]);
    const res = sb.run(["tmux", "kill", "api"]);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /ended tmux session "api"/);
    assert.match(sb.run(["tmux", "ls"]).stdout, /^api2 /m);
    assert.doesNotMatch(sb.run(["tmux", "ls"]).stdout, /^api /m);
    const missing = sb.run(["tmux", "kill", "nope"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no xclaude tmux session "nope" \(sessions: api2\)/);
  });

  it("attaches from outside tmux, and switches from inside", async (t) => {
    if (!needTmux(sb, t)) return;
    sb.run(["tmux", "new", "api", "--detach", "--empty"]);
    sb.run(["tmux", "new", "other", "--detach", "--empty"]);
    // A terminal outside the sandbox's server: a pane of a second server, without TMUX.
    outer(["new-session", "-d", "-s", "term", "-x", "100", "-y", "30", "env -u TMUX xclaude tmux attach api"]);
    await waitFor(() => clientSessions().includes("xclaude--api"), "the attach");
    assert.match(sb.run(["tmux", "ls"]).stdout, /^api\s+–\s+~\s+yes/m);
    // Inside the session: switch-client instead of a nested attach.
    tmux(sb, ["send-keys", "-t", "xclaude--api", "xclaude tmux attach other", "Enter"]);
    await waitFor(() => clientSessions().includes("xclaude--other"), "the switch");
    assert.deepEqual(clientSessions(), ["xclaude--other"]);
  });

  it("picks a session when no label is given", async (t) => {
    if (!needTmux(sb, t)) return;
    sb.run(["tmux", "new", "first", "--detach", "--empty"]);
    sb.run(["tmux", "new", "second", "--detach", "--empty"]);
    outer(["new-session", "-d", "-s", "term", "-x", "100", "-y", "30", "env -u TMUX xclaude tmux attach"]);
    await waitFor(() => outer(["capture-pane", "-p", "-t", "term"]).stdout.includes("Attach to tmux session"), "the session picker");
    outer(["send-keys", "-t", "term", "j", "Enter"]);
    await waitFor(() => clientSessions().length > 0, "the attach");
    assert.equal(clientSessions().length, 1);
  });

  it("needs a label without a terminal, and sessions to attach to", (t) => {
    if (!needTmux(sb, t)) return;
    let res = sb.run(["tmux", "attach"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no xclaude tmux sessions; start one with/);
    sb.run(["tmux", "new", "api", "--detach", "--empty"]);
    res = sb.run(["tmux", "attach"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /label required: xclaude tmux attach <label> \(sessions: api\)/);
  });

  it("rm lists the account's sessions and leaves them running", (t) => {
    if (!needTmux(sb, t)) return;
    sb.run(["tmux", "new", "api", "--detach", "acme"]);
    sb.run(["tmux", "new", "web", "--detach", "acme"]);
    sb.run(["tmux", "new", "b", "--detach", "beta"]);
    const res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /tmux sessions still running on acme \(left alone\): api, web/);
    assert.equal(tmux(sb, ["list-sessions"]).stdout.trim().split("\n").length, 3);
  });
});
