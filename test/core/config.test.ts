import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  accountNameProblem,
  defaultConfig,
  defaultsOf,
  describeDefaults,
  identities,
  loadConfig,
  parseConfig,
  saveConfig,
} from "../../src/core/config.ts";
import { XError } from "../../src/core/errors.ts";
import { type Paths, resolvePaths } from "../../src/core/paths.ts";
import { removeTemp, tempDir } from "../helpers/tmp.ts";

let root: string;
let paths: Paths;
beforeEach(() => {
  root = tempDir();
  paths = resolvePaths({ HOME: root });
});
afterEach(() => removeTemp(root));

const parse = (obj: unknown) => parseConfig(JSON.stringify(obj), "config.json");

describe("account names", () => {
  it("accepts the documented pattern", () => {
    for (const ok of ["acme", "a", "personal", "org-2", "a".repeat(32)]) assert.equal(accountNameProblem(ok), null, ok);
  });

  it("rejects reserved names and bad patterns", () => {
    for (const bad of ["main", "add", "rm", "ls", "set", "tmux", "doctor", "shell", "guard", "help", "-x", "_x", "__complete"]) {
      assert.match(accountNameProblem(bad)!, /reserved/, bad);
    }
    for (const bad of ["Acme", "2org", "a_b", "a.b", "", "a".repeat(33), "a b"]) {
      assert.match(accountNameProblem(bad)!, /isn't a valid account name/, bad);
    }
  });
});

describe("parseConfig", () => {
  it("fills in missing fields", () => {
    assert.deepEqual(parse({}), defaultConfig());
    const c = parse({ accounts: { acme: {} } });
    assert.deepEqual(c.accounts.acme, { model: null, effort: null, args: [] });
  });

  it("reads a full example", () => {
    const c = parse({
      version: 1,
      main: { enabled: false, model: null, effort: null, args: [] },
      accounts: {
        personal: { model: null, effort: null, args: [] },
        acme: { model: "opus", effort: "max", args: ["--chrome"] },
      },
      share: { add: [], remove: [] },
      guard: false,
      tmux: { statusRight: true },
      claudePath: null,
    });
    assert.deepEqual(c.accounts.acme, { model: "opus", effort: "max", args: ["--chrome"] });
    assert.deepEqual(identities(c), ["personal", "acme"]);
  });

  it("rejects main under accounts, bad efforts and wrong types", () => {
    assert.throws(() => parse({ accounts: { main: {} } }), /reserved for the main identity/);
    assert.throws(() => parse({ accounts: { acme: { effort: "extreme" } } }), /accounts\.acme\.effort must be one of low, medium, high, xhigh, max, ultracode/);
    assert.throws(() => parse({ accounts: { acme: { args: "--chrome" } } }), /accounts\.acme\.args must be a list of strings/);
    assert.throws(() => parse({ guard: "yes" }), /guard must be true or false/);
    assert.throws(() => parse({ version: 2 }), /version 2 isn't supported/);
    assert.throws(() => parse({ share: { add: ["a/b"] } }), /isn't an entry name/);
    assert.throws(() => parse([]), /top level must be an object/);
  });

  it("names the file for invalid JSON", () => {
    assert.throws(() => parseConfig("{", "~/.xclaude/config.json"), (e: unknown) => {
      assert.ok(e instanceof XError);
      assert.match(e.message, /^~\/\.xclaude\/config\.json isn't valid JSON/);
      return true;
    });
  });

  it("keeps unknown keys", () => {
    const c = parse({ future: { x: 1 }, accounts: { acme: { color: "red" } } });
    const round = JSON.parse(JSON.stringify(c));
    assert.deepEqual(round.future, { x: 1 });
    assert.equal(round.accounts.acme.color, "red");
  });
});

describe("loadConfig and saveConfig", () => {
  it("creates ~/.xclaude, config.json and state.json on the first run", () => {
    const { config, created } = loadConfig(paths, { create: true });
    assert.equal(created, true);
    assert.deepEqual(config, defaultConfig());
    assert.deepEqual(fs.readdirSync(paths.xhome).sort(), ["config.json", "state.json"]);
    assert.equal(fs.statSync(paths.xhome).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.config).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.state).mode & 0o777, 0o600);
    assert.equal(loadConfig(paths, { create: true }).created, false);
  });

  it("returns defaults without creating anything when asked not to", () => {
    const { created } = loadConfig(paths, { create: false });
    assert.equal(created, false);
    assert.equal(fs.existsSync(paths.xhome), false);
  });

  it("round-trips", () => {
    const c = defaultConfig();
    c.accounts.acme = { model: "opus", effort: "high", args: ["--add-dir", "/x"] };
    c.guard = true;
    saveConfig(paths, c);
    assert.deepEqual(loadConfig(paths, { create: false }).config, c);
    assert.ok(fs.readFileSync(paths.config, "utf8").endsWith("}\n"));
  });

  it("reports an invalid file with its path", () => {
    fs.mkdirSync(paths.xhome, { recursive: true });
    fs.writeFileSync(paths.config, JSON.stringify({ accounts: { Bad: {} } }));
    assert.throws(() => loadConfig(paths, { create: true }), /^Error: ~\/\.xclaude\/config\.json: accounts: "Bad" isn't a valid account name/);
  });
});

describe("identities and defaults", () => {
  it("lists main last and only when enabled", () => {
    const c = defaultConfig();
    c.accounts.b = { model: null, effort: null, args: [] };
    c.accounts.a = { model: null, effort: null, args: [] };
    assert.deepEqual(identities(c), ["b", "a"]);
    assert.equal(defaultsOf(c, "main"), null);
    c.main.enabled = true;
    assert.deepEqual(identities(c), ["b", "a", "main"]);
    assert.equal(defaultsOf(c, "main"), c.main);
    assert.equal(defaultsOf(c, "constructor"), null);
  });

  it("describes defaults", () => {
    assert.equal(describeDefaults({ model: "opus", effort: "max", args: ["--chrome"] }), "opus · max · --chrome");
    assert.equal(describeDefaults({ model: null, effort: null, args: [] }), "");
  });
});
