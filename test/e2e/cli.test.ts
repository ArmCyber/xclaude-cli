// The built CLI: help, version, first run and exit codes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

describe("cli", () => {
  it("prints the version and help without creating anything", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    for (const flag of ["-v", "--version"]) assert.equal(sb.run([flag]).stdout, `${pkg.version}\n`);
    for (const flag of ["-h", "--help"]) {
      const res = sb.run([flag]);
      assert.equal(res.status, 0);
      assert.match(res.stdout, /^xclaude — run Claude Code/);
    }
    for (const args of [["help"], ["help", "rm"], ["help", "--help"], ["add", "--help"], ["tmux", "-h"], ["tmux", "new", "--help"], ["tmux", "attach", "-h"], ["tmux", "ls", "--help"]]) {
      const res = sb.run(args);
      assert.equal(res.status, 0, args.join(" "));
      assert.equal(res.stderr, "", args.join(" "));
      assert.match(res.stdout, args[0] === "help" && args.length === 1 ? /^xclaude — / : new RegExp(`^Usage: xclaude ${args[0] === "help" ? args[1] === "rm" ? "rm" : "help" : args[0]}`), args.join(" "));
    }
    assert.equal(fs.existsSync(sb.xhome), false);
  });

  it("creates ~/.xclaude on the first run and prints a hint once", () => {
    let res = sb.run(["ls"]);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /created ~\/\.xclaude\. Next: `xclaude add <name>`/);
    assert.deepEqual(fs.readdirSync(sb.xhome).sort(), ["config.json", "state.json"]);
    res = sb.run(["ls"]);
    assert.equal(res.stderr, "");
  });

  it("prints command help", () => {
    const res = sb.run(["help", "tmux"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^Usage: xclaude tmux new <label>/);
    assert.match(sb.run(["add", "--help"]).stdout, /^Usage: xclaude add <name>/);
  });

  it("exits 2 for an unknown account or command", () => {
    sb.run(["ls"]); // creates ~/.xclaude, so the hint doesn't show below
    const res = sb.run(["nope"]);
    assert.equal(res.status, 2);
    assert.equal(res.stderr, 'xclaude: unknown account or command "nope" (no accounts yet; add one with: xclaude add <name>)\n');
    assert.equal(sb.run(["help", "nope"]).status, 2);
  });

  it("exits 1 for a broken config, naming the file", () => {
    fs.mkdirSync(sb.xhome, { recursive: true });
    fs.writeFileSync(path.join(sb.xhome, "config.json"), "{");
    const res = sb.run(["ls"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^xclaude: ~\/\.xclaude\/config\.json isn't valid JSON/);
  });
});
