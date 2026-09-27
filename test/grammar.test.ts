import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { EXIT_ERROR, EXIT_USAGE, XError } from "../src/core/errors.ts";
import { type Action, classify } from "../src/grammar.ts";

const config = defaultConfig();
config.accounts.acme = { model: "opus", effort: "max", args: [] };
config.accounts.personal = { model: null, effort: null, args: [] };

const withMain = defaultConfig();
withMain.main.enabled = true;

// argv → expected action
const table: Array<[string[], Action]> = [
  [[], { kind: "launch", account: null, args: [] }],
  [["-v"], { kind: "version" }],
  [["--version"], { kind: "version" }],
  [["-h"], { kind: "help" }],
  [["--help"], { kind: "help" }],
  [["-c"], { kind: "launch", account: null, args: ["-c"] }],
  [["--chrome", "-p", "hi"], { kind: "launch", account: null, args: ["--chrome", "-p", "hi"] }],
  [["-"], { kind: "launch", account: null, args: ["-"] }],
  [["acme"], { kind: "launch", account: "acme", args: [] }],
  [["acme", "-c", "--chrome"], { kind: "launch", account: "acme", args: ["-c", "--chrome"] }],
  [["acme", "auth", "status"], { kind: "launch", account: "acme", args: ["auth", "status"] }],
  [["acme", "--help"], { kind: "launch", account: "acme", args: ["--help"] }],
  [["acme", "--version"], { kind: "launch", account: "acme", args: ["--version"] }],
  [["add", "new"], { kind: "command", name: "add", args: ["new"] }],
  [["rm", "acme", "-y"], { kind: "command", name: "rm", args: ["acme", "-y"] }],
  [["ls"], { kind: "command", name: "ls", args: [] }],
  [["set", "main", "--enable"], { kind: "command", name: "set", args: ["main", "--enable"] }],
  [["tmux", "new", "api", "acme"], { kind: "command", name: "tmux", args: ["new", "api", "acme"] }],
  [["doctor", "--fix"], { kind: "command", name: "doctor", args: ["--fix"] }],
  [["shell", "install"], { kind: "command", name: "shell", args: ["install"] }],
  [["guard", "on"], { kind: "command", name: "guard", args: ["on"] }],
  [["help", "tmux"], { kind: "command", name: "help", args: ["tmux"] }],
  [["__complete", "bash", "1", "xclaude", ""], { kind: "hidden", name: "__complete", args: ["bash", "1", "xclaude", ""] }],
  [["__names"], { kind: "hidden", name: "__names", args: [] }],
];

describe("grammar", () => {
  for (const [argv, expected] of table) {
    it(`xclaude ${argv.join(" ") || "(nothing)"}`, () => {
      assert.deepEqual(classify(argv, config), expected);
    });
  }

  it("launches main only when it's enabled", () => {
    assert.deepEqual(classify(["main", "-c"], withMain), { kind: "launch", account: "main", args: ["-c"] });
    assert.throws(
      () => classify(["main"], config),
      (e: unknown) => e instanceof XError && e.exitCode === EXIT_ERROR && /xclaude set main --enable/.test(e.message),
    );
  });

  it("rejects unknown words, listing the accounts", () => {
    for (const word of ["nope", "_x", "__other", "Acme"]) {
      assert.throws(
        () => classify([word], config),
        (e: unknown) =>
          e instanceof XError &&
          e.exitCode === EXIT_USAGE &&
          e.message === `unknown account or command "${word}" (accounts: acme, personal)`,
      );
    }
  });

  it("points to xclaude add when there are no accounts", () => {
    assert.throws(() => classify(["nope"], defaultConfig()), /no accounts yet; add one with: xclaude add <name>/);
  });
});
