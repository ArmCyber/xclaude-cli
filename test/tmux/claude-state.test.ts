// The CLAUDE column, with fake agents JSON and real processes in panes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { describeAgent, parentLookup, sessionOfPid, statesBySession } from "../../src/tmux/claude-state.ts";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.ts";
import { needTmux, tmux, waitFor } from "../helpers/tmux.ts";

describe("CLAUDE column, pure parts", () => {
  it("describes agent states", () => {
    assert.deepEqual(describeAgent({ status: "busy" }), { text: "working", rank: 2 });
    assert.deepEqual(describeAgent({ status: "waiting", waitingFor: "permission prompt" }), { text: "needs input (permission prompt)", rank: 3 });
    assert.deepEqual(describeAgent({ status: "waiting" }), { text: "needs input", rank: 3 });
    assert.deepEqual(describeAgent({ status: "idle" }), { text: "idle", rank: 1 });
    assert.equal(describeAgent({}), null);
  });

  it("walks parents up to a pane and keeps the most urgent state", () => {
    const parents = new Map([
      [30, 20],
      [20, 10],
      [31, 21],
      [21, 11],
      [99, 1],
    ]);
    const parentOf = (p: number) => parents.get(p) ?? null;
    const panes = new Map([
      [10, "$1"],
      [11, "$2"],
      [12, "$2"],
    ]);
    assert.equal(sessionOfPid(30, panes, parentOf), "$1");
    assert.equal(sessionOfPid(12, panes, parentOf), "$2", "the pane process itself");
    assert.equal(sessionOfPid(99, panes, parentOf), null);
    const states = statesBySession(
      [
        { pid: 30, status: "idle" },
        { pid: 31, status: "busy" },
        { pid: 12, status: "waiting", waitingFor: "dialog open" },
        { pid: 99, status: "busy" },
        { status: "busy" },
      ],
      panes,
      parentOf,
    );
    assert.deepEqual(Object.fromEntries(states), { $1: "idle", $2: "needs input (dialog open)" });
  });

  it("finds this process's parent", () => {
    assert.equal(parentLookup()(process.pid), process.ppid);
  });
});

describe("CLAUDE column in tmux ls", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    fs.mkdirSync(sb.xhome, { recursive: true });
    fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify({ accounts: { acme: {}, beta: {} } }));
  });
  afterEach(() => sb.cleanup());

  it("shows each session's most urgent Claude state", async (t) => {
    if (!needTmux(sb, t)) return;
    for (const label of ["s1", "s2", "s3"]) sb.run(["tmux", "new", label, "--detach", "--empty"]);
    const pidFile = (n: string) => path.join(sb.root, `${n}.pid`);
    // A child of the pane's shell…
    tmux(sb, ["send-keys", "-t", "xclaude--s1", `sh -c 'echo $$ > ${pidFile("a")}; exec sleep 300'`, "Enter"]);
    tmux(sb, ["send-keys", "-t", "xclaude--s2", `sh -c 'echo $$ > ${pidFile("b")}; exec sleep 300'`, "Enter"]);
    // …and a pane process itself, in a second window of s2.
    tmux(sb, ["new-window", "-t", "xclaude--s2", `sh -c 'echo $$ > ${pidFile("c")}; exec sleep 300'`]);
    await waitFor(() => ["a", "b", "c"].every((n) => fs.existsSync(pidFile(n)) && fs.readFileSync(pidFile(n), "utf8").trim()), "the sleeps");
    const pid = (n: string) => Number(fs.readFileSync(pidFile(n), "utf8"));
    const agents = path.join(sb.root, "agents.json");
    fs.writeFileSync(
      agents,
      JSON.stringify([
        { cwd: "/x", kind: "interactive", startedAt: 1, pid: pid("a"), status: "busy" },
        { cwd: "/x", kind: "interactive", startedAt: 1, pid: pid("b"), status: "idle" },
        { cwd: "/x", kind: "interactive", startedAt: 1, pid: pid("c"), status: "waiting", waitingFor: "permission prompt" },
        { cwd: "/x", kind: "background", startedAt: 1, id: "bg1", state: "working" },
      ]),
    );
    const out = sb.run(["tmux", "ls"], { env: { FAKE_CLAUDE_AGENTS: agents } }).stdout;
    assert.match(out, /^s1\s.*\sworking$/m);
    assert.match(out, /^s2\s.*\sneeds input \(permission prompt\)$/m);
    assert.match(out, /^s3\s.*\s–$/m);
    const calls = sb.fakeCalls().filter((c) => c.argv.join(" ") === "agents --json");
    assert.equal(calls.length, 1, "one call covers every account");

    sb.run(["tmux", "ls"], { env: { FAKE_CLAUDE_AGENTS: agents, XCLAUDE_SWITCHES: "agentsPerAccount=1" } });
    const perAccount = sb.fakeCalls().filter((c) => c.argv.join(" ") === "agents --json").slice(1);
    assert.deepEqual(perAccount.map((c) => c.env.XCLAUDE_ACCOUNT).sort(), ["acme", "beta"]);
  });
});
