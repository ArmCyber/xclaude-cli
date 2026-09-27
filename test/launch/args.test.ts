import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { FALLBACK_HELP, parseHelp } from "../../src/claude/help.ts";
import type { Defaults } from "../../src/core/config.ts";
import { buildArgs, hasFlag, needsHelp, normalizeAccountArgs } from "../../src/launch/args.ts";
import { fixtures } from "../helpers/sandbox.ts";

const help = parseHelp(fs.readFileSync(path.join(fixtures, "claude-help.txt"), "utf8"));
const d = (model: string | null, effort: Defaults["effort"], args: string[] = []): Defaults => ({ model, effort, args });

describe("buildArgs", () => {
  it("injects defaults before the user's arguments", () => {
    assert.deepEqual(buildArgs(d("opus", "max", ["--chrome"]), ["-c"], help), ["--chrome", "--model", "opus", "--effort", "max", "-c"]);
    assert.deepEqual(buildArgs(d(null, null), ["-c", "--chrome"], help), ["-c", "--chrome"]);
    assert.deepEqual(buildArgs(d("opus", null), [], help), ["--model", "opus"]);
  });

  it("lets typed --model and --effort win, in both spellings", () => {
    assert.deepEqual(buildArgs(d("opus", "max"), ["--model", "sonnet"], help), ["--effort", "max", "--model", "sonnet"]);
    assert.deepEqual(buildArgs(d("opus", "max"), ["--effort=low", "-p", "hi"], help), ["--model", "opus", "--effort=low", "-p", "hi"]);
    assert.deepEqual(buildArgs(d("opus", "max"), ["--model=haiku", "--effort", "high"], help), ["--model=haiku", "--effort", "high"]);
  });

  it("passes subcommands through unchanged", () => {
    for (const sub of [["auth", "status"], ["mcp", "add", "x", "--", "npx", "y"], ["plugin", "install", "p"], ["agents", "--json"], ["daemon", "stop", "--any"], ["doctor"], ["update"], ["attach", "abc"]]) {
      assert.deepEqual(buildArgs(d("opus", "max", ["--chrome"]), sub, help), sub, sub.join(" "));
    }
  });

  it("treats a prompt as a prompt", () => {
    assert.deepEqual(buildArgs(d("opus", null), ["fix the auth bug"], help), ["--model", "opus", "fix the auth bug"]);
    // "update" as the first word is Claude Code's subcommand, as documented.
    assert.deepEqual(buildArgs(d("opus", null), ["-p", "update"], help), ["--model", "opus", "-p", "update"]);
  });

  it("writes account args that take values as --flag=value, one per value", () => {
    assert.deepEqual(buildArgs(d(null, null, ["--add-dir", "/a", "/b", "--chrome"]), ["summarize this"], help), [
      "--add-dir=/a",
      "--add-dir=/b",
      "--chrome",
      "summarize this",
    ]);
  });

  it("keeps the user's arguments exactly as typed", () => {
    const user = ["--add-dir", "/x", "fix it", "--", "--model"];
    assert.deepEqual(buildArgs(d("opus", null), user, help).slice(-5), user);
    assert.deepEqual(buildArgs(d("opus", null), ["--", "--model"], help), ["--model", "opus", "--", "--model"]);
  });
});

describe("bare optional-value account flags", () => {
  it("go last, so they can't take the prompt as their value", () => {
    assert.deepEqual(buildArgs(d(null, null, ["--remote-control"]), ["fix the bug"], help), ["fix the bug", "--remote-control"]);
    assert.deepEqual(buildArgs(d("opus", null, ["-w", "--chrome"]), ["fix it"], help), ["--chrome", "--model", "opus", "fix it", "--worktree"]);
    assert.deepEqual(buildArgs(d(null, null, ["--remote-control"]), ["-p", "x", "--", "--y"], help), ["-p", "x", "--remote-control", "--", "--y"]);
    assert.deepEqual(buildArgs(d(null, null, ["--remote-control"]), [], help), ["--remote-control"]);
  });

  it("give way to the same flag typed by the user", () => {
    assert.deepEqual(buildArgs(d(null, null, ["--worktree"]), ["-w", "mine", "go"], help), ["-w", "mine", "go"]);
    assert.deepEqual(buildArgs(d(null, null, ["--remote-control"]), ["--remote-control=name"], help), ["--remote-control=name"]);
  });

  it("keep their value when they have one", () => {
    assert.deepEqual(buildArgs(d(null, null, ["--remote-control", "office"]), ["hi"], help), ["--remote-control=office", "hi"]);
  });
});

describe("normalizeAccountArgs", () => {
  it("handles every value kind", () => {
    assert.deepEqual(normalizeAccountArgs(["--permission-mode", "plan"], help), ["--permission-mode=plan"]);
    assert.deepEqual(normalizeAccountArgs(["-n", "work"], help), ["--name=work"]);
    assert.deepEqual(normalizeAccountArgs(["--debug", "api", "--verbose"], help), ["--debug=api", "--verbose"]);
    assert.deepEqual(normalizeAccountArgs(["--debug", "--verbose"], help), ["--verbose", "--debug"], "a bare optional-value flag goes last");
    assert.deepEqual(normalizeAccountArgs(["--mcp-config", "a.json", "b.json"], help), ["--mcp-config=a.json", "--mcp-config=b.json"]);
    assert.deepEqual(normalizeAccountArgs(["--add-dir"], help), ["--add-dir"]);
    assert.deepEqual(normalizeAccountArgs(["--append-system-prompt", "-be terse"], help), ["--append-system-prompt=-be terse"]);
  });

  it("passes unknown flags, --flag=value and positionals as written", () => {
    assert.deepEqual(normalizeAccountArgs(["--future-flag", "x", "--model=opus", "word", "-"], help), ["--future-flag", "x", "--model=opus", "word", "-"]);
    assert.deepEqual(normalizeAccountArgs(["--", "--add-dir", "x"], help), ["--", "--add-dir", "x"]);
  });

  it("works with the fallback help", () => {
    assert.deepEqual(normalizeAccountArgs(["--add-dir", "/a", "/b"], FALLBACK_HELP), ["--add-dir=/a", "--add-dir=/b"]);
  });
});

describe("hasFlag and needsHelp", () => {
  it("detects typed flags before --", () => {
    assert.ok(hasFlag(["-c", "--model", "x"], "--model"));
    assert.ok(hasFlag(["--model=x"], "--model"));
    assert.ok(!hasFlag(["--models"], "--model"));
    assert.ok(!hasFlag(["--", "--model"], "--model"));
  });

  it("skips the help parse when nothing needs it", () => {
    assert.equal(needsHelp(d("opus", "max"), []), false);
    assert.equal(needsHelp(d("opus", "max"), ["-c"]), false);
    assert.equal(needsHelp(d(null, null), ["auth"]), true);
    assert.equal(needsHelp(d(null, null, ["--chrome"]), []), true);
  });
});
