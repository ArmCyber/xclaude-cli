// The picker: the state machine, and a real terminal run in tmux.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { emptyState } from "../../src/core/state.ts";
import { parseKeys, preselect, render, step } from "../../src/launch/picker.ts";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.ts";
import { capture, needTmux, startPane, tmux, waitFor } from "../helpers/tmux.ts";

describe("picker keys", () => {
  it("parses arrows, j/k, digits, Enter, Esc and Ctrl-C", () => {
    assert.deepEqual(parseKeys("\x1b[A\x1b[B\x1bOA\x1bOB"), ["up", "down", "up", "down"]);
    assert.deepEqual(parseKeys("kj"), ["up", "down"]);
    assert.deepEqual(parseKeys("3"), [{ jump: 2 }]);
    assert.deepEqual(parseKeys("\r"), ["enter"]);
    assert.deepEqual(parseKeys("\n"), ["enter"]);
    assert.deepEqual(parseKeys("\x1b"), ["cancel"]);
    assert.deepEqual(parseKeys("\x03"), ["cancel"]);
    assert.deepEqual(parseKeys("\x1b[1;5C"), [null], "other sequences are skipped whole");
    assert.deepEqual(parseKeys("x0"), [null, null]);
  });

  it("moves, wraps, jumps and finishes", () => {
    assert.deepEqual(step(0, 3, "down"), { index: 1 });
    assert.deepEqual(step(2, 3, "down"), { index: 0 });
    assert.deepEqual(step(0, 3, "up"), { index: 2 });
    assert.deepEqual(step(0, 3, { jump: 2 }), { index: 2 });
    assert.deepEqual(step(0, 3, { jump: 5 }), { index: 0 }, "out of range is ignored");
    assert.deepEqual(step(1, 3, "enter"), { index: 1, done: "chosen" });
    assert.deepEqual(step(1, 3, "cancel"), { index: 1, done: "cancelled" });
    assert.deepEqual(step(1, 3, null), { index: 1 });
  });

  it("renders every entry with its number and defaults", () => {
    const lines = render("Launch Claude Code as", [{ label: "acme", detail: "opus · max" }, { label: "personal" }], 0);
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.equal(plain[0], "Launch Claude Code as");
    assert.equal(plain[1], "❯ 1  acme      opus · max");
    assert.equal(plain[2], "  2  personal");
    assert.match(plain[3]!, /Enter to choose/);
    const narrow = render("t", [{ label: "acme", detail: "a very long description of defaults" }], 0, 20).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    assert.ok(narrow.every((l) => l.length <= 20));
  });

  it("preselects the account last used here, then the last one used", () => {
    const state = emptyState();
    assert.equal(preselect(["a", "b", "c"], state, "/x"), 0);
    state.lastUsedAccount = "c";
    assert.equal(preselect(["a", "b", "c"], state, "/x"), 2);
    state.lastAccountByDir["/x"] = "b";
    assert.equal(preselect(["a", "b", "c"], state, "/x"), 1);
    state.lastAccountByDir["/x"] = "gone";
    assert.equal(preselect(["a", "b", "c"], state, "/x"), 2);
  });
});

describe("picker in a terminal", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    fs.mkdirSync(sb.xhome, { recursive: true });
    fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify({ accounts: { acme: { model: "opus" }, beta: {}, gamma: {} } }));
  });
  afterEach(() => sb.cleanup());

  const launched = () => sb.fakeCalls().filter((c) => c.argv[0] !== "--help").at(-1);

  it("picks with the keyboard and launches, passing flags through", async (t) => {
    if (!needTmux(sb, t)) return;
    const status = path.join(sb.root, "status");
    startPane(sb, "p", `xclaude -c; echo $? > ${status}`);
    await waitFor(() => capture(sb, "p").includes("Launch Claude Code as"), "the picker");
    const screen = capture(sb, "p");
    assert.match(screen, /❯ 1 {2}acme {3}opus/);
    assert.match(screen, / {2}2 {2}beta/);
    tmux(sb, ["send-keys", "-t", "p", "j", "j", "k", "Enter"]);
    await waitFor(() => fs.existsSync(status), "xclaude to finish");
    assert.equal(fs.readFileSync(status, "utf8").trim(), "0");
    const call = launched()!;
    assert.equal(call.env.XCLAUDE_ACCOUNT, "beta");
    assert.deepEqual(call.argv, ["-c"]);
  });

  it("preselects the last account used in the directory and jumps with digits", async (t) => {
    if (!needTmux(sb, t)) return;
    fs.writeFileSync(path.join(sb.xhome, "state.json"), JSON.stringify({ lastAccountByDir: { [sb.home]: "gamma" } }));
    const status = path.join(sb.root, "status");
    startPane(sb, "p", `xclaude; echo $? > ${status}`);
    await waitFor(() => capture(sb, "p").includes("❯ 3  gamma"), "gamma preselected");
    tmux(sb, ["send-keys", "-t", "p", "1", "Enter"]);
    await waitFor(() => fs.existsSync(status), "xclaude to finish");
    assert.equal(launched()!.env.XCLAUDE_ACCOUNT, "acme");
  });

  it("cancels with Esc (exit 130) and restores the terminal", async (t) => {
    if (!needTmux(sb, t)) return;
    const status = path.join(sb.root, "status");
    startPane(sb, "p", `xclaude; echo $? > ${status}; stty -a > ${status}.stty; sleep 30`);
    await waitFor(() => capture(sb, "p").includes("Launch Claude Code as"), "the picker");
    tmux(sb, ["send-keys", "-t", "p", "Escape"]);
    await waitFor(() => fs.existsSync(`${status}.stty`) && fs.statSync(`${status}.stty`).size > 0, "xclaude to finish");
    assert.equal(fs.readFileSync(status, "utf8").trim(), "130");
    const stty = fs.readFileSync(`${status}.stty`, "utf8");
    assert.match(stty, /(^|\s)icanon(\s|$)/, "canonical mode is back");
    assert.match(stty, /(^|\s)echo(\s|$)/, "echo is back");
    assert.equal(launched(), undefined);
    assert.doesNotMatch(capture(sb, "p"), /Launch Claude Code as/, "the picker was erased");
  });

  it("hands claude the terminal's descriptors and signal dispositions exactly as the shell gave them", async (t) => {
    if (!needTmux(sb, t)) return;
    // Node makes a terminal it reads from non-blocking; claude must never inherit that.
    const probe = path.join(sb.bin, "probe");
    fs.writeFileSync(
      probe,
      // The access mode and O_NONBLOCK only: macOS also marks a descriptor that was written to.
      `#!/bin/sh\nperl -MFcntl -e 'for (0..2) { open(my $f, "<&=", $_) or next; my $fl = fcntl($f, F_GETFL, 0); printf "%d:%d%s ", $_, $fl & O_ACCMODE, ($fl & O_NONBLOCK) ? "+nonblock" : "" } print "PIPE=", ($SIG{PIPE} // ""), " XFSZ=", ($SIG{XFSZ} // "")' > "$PROBE_OUT"\n`,
      { mode: 0o755 },
    );
    const run = async (name: string, command: string, keys: string[] = []) => {
      const out = path.join(sb.root, `${name}.flags`);
      // Each run gets its own session on the same server: restarting the server could let the
      // next session reach the old one while it's still exiting.
      startPane(sb, name, `PROBE_OUT=${out} XCLAUDE_CLAUDE_PATH=${probe} ${command}; sleep 30`);
      if (keys.length) {
        await waitFor(() => capture(sb, name).includes("Launch Claude Code as"), "the picker");
        tmux(sb, ["send-keys", "-t", name, ...keys]);
      }
      await waitFor(() => fs.existsSync(out) && fs.statSync(out).size > 0, `${name} probe`);
      return fs.readFileSync(out, "utf8");
    };
    const direct = await run("direct", probe);
    assert.equal(await run("account", "xclaude acme"), direct);
    assert.equal(await run("picker", "xclaude", ["Enter"]), direct);
  });
});

