import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FALLBACK_HELP, findOption, isSubcommand, loadHelp, longName, parseHelp } from "../../src/claude/help.ts";
import { fakeClaude, fixtures } from "../helpers/sandbox.ts";
import { removeTemp, tempDir } from "../helpers/tmp.ts";

const fixture = fs.readFileSync(path.join(fixtures, "claude-help.txt"), "utf8");
const help = parseHelp(fixture);

describe("parseHelp on the captured Claude Code help", () => {
  it("finds options with every value kind", () => {
    const kinds = (flag: string) => findOption(help, flag)?.value;
    assert.equal(kinds("--add-dir"), "variadic");
    assert.equal(kinds("--model"), "required");
    assert.equal(kinds("--effort"), "required");
    assert.equal(kinds("--resume"), "optional");
    assert.equal(kinds("-r"), "optional");
    assert.equal(kinds("-d"), "optional");
    assert.equal(kinds("--continue"), "none");
    assert.equal(kinds("-c"), "none");
    assert.equal(kinds("--chrome"), "none");
    assert.equal(kinds("--no-chrome"), "none");
    assert.equal(kinds("--tmux"), "none");
    assert.equal(kinds("--allowed-tools"), "variadic");
    assert.equal(kinds("--allowedTools"), "variadic");
    assert.equal(kinds("--mcp-config"), "variadic");
    assert.equal(kinds("--plugin-dir"), "required");
    assert.equal(kinds("--exclude-dynamic-system-prompt-sections"), "none");
    assert.equal(kinds("--remote-control-session-name-prefix"), "required");
  });

  it("keeps aliases, placeholders, descriptions and choices", () => {
    const bg = findOption(help, "--bg")!;
    assert.deepEqual(bg.names, ["--bg", "--background"]);
    const addDir = findOption(help, "--add-dir")!;
    assert.equal(addDir.placeholder, "directories");
    assert.match(addDir.description, /^Additional directories to allow tool access to$/);
    assert.deepEqual(findOption(help, "--permission-mode")!.choices, ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
    assert.deepEqual(findOption(help, "--output-format")!.choices, ["text", "json", "stream-json"]);
    assert.equal(longName(findOption(help, "-n")!), "--name");
    assert.equal(findOption(help, "--model=opus")?.names[0], "--model");
  });

  it("finds subcommands, with aliases", () => {
    for (const s of ["agents", "attach", "auth", "doctor", "install", "mcp", "plugin", "plugins", "setup-token", "stop", "kill", "update", "upgrade", "ultrareview"]) {
      assert.ok(help.subcommands.includes(s), s);
    }
    assert.ok(!help.subcommands.includes("prompt"));
  });

  it("counts hidden subcommands from the fallback list", () => {
    assert.ok(!help.subcommands.includes("daemon"), "daemon is hidden from --help");
    assert.equal(isSubcommand("daemon", help), true);
    assert.equal(isSubcommand("attach", help), true);
    assert.equal(isSubcommand("attach", null), false, "without the parse, only the fallback list counts");
    assert.equal(isSubcommand("fix the bug", help), false);
    assert.equal(isSubcommand("-c", help), false);
    assert.equal(isSubcommand(undefined, help), false);
  });

  it("has a usable fallback", () => {
    assert.equal(findOption(FALLBACK_HELP, "--add-dir")!.value, "variadic");
    assert.ok(FALLBACK_HELP.subcommands.includes("daemon"));
  });
});

describe("loadHelp", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir();
  });
  afterEach(() => removeTemp(root));

  it("runs claude --help once per build and caches the parse", () => {
    const bin = path.join(root, "claude");
    fs.copyFileSync(fakeClaude, bin);
    fs.chmodSync(bin, 0o755);
    const log = path.join(root, "calls.jsonl");
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HELP: path.join(fixtures, "claude-help.txt") };
    const cache = path.join(root, "cache");
    const first = loadHelp(bin, cache, env);
    assert.ok(findOption(first, "--add-dir"));
    const second = loadHelp(bin, cache, env);
    assert.deepEqual(second, first);
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "the second call is served from the cache");
    assert.equal(fs.statSync(path.join(cache, "claude-help.json")).mode & 0o777, 0o600);

    // A new build (different mtime) is parsed again.
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(bin, later, later);
    loadHelp(bin, cache, env);
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 2);
  });

  it("falls back when --help fails, and remembers that for the build", () => {
    const bin = path.join(root, "claude");
    const calls = path.join(root, "calls");
    fs.writeFileSync(bin, `#!/bin/sh\necho x >> ${calls}\nexit 3\n`, { mode: 0o755 });
    const cache = path.join(root, "cache");
    assert.deepEqual(loadHelp(bin, cache, { PATH: "/usr/bin:/bin" }), FALLBACK_HELP);
    assert.deepEqual(loadHelp(bin, cache, { PATH: "/usr/bin:/bin" }), FALLBACK_HELP);
    assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1, "--help ran once");
  });
});
