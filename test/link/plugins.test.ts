// Plugins installed under another login: named in the account's settings as off.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DirLock, STORE_LOCK } from "../../src/core/lock.ts";
import { loadState } from "../../src/core/state.ts";
import { listPlugins, planPlugins, userPlugins, writePlan } from "../../src/link/plugins.ts";
import { type Home, makeHome } from "../helpers/accounts.ts";

let h: Home;
let settings: string;
beforeEach(() => {
  h = makeHome();
  h.account("acme");
  h.repair("acme");
  settings = path.join(h.paths.xhome, "accounts", "acme", "settings.json");
});
afterEach(() => h.cleanup());

function writeRegistry(plugins: Record<string, Array<Record<string, unknown>>>): void {
  fs.writeFileSync(path.join(h.S, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins }, null, 2));
}

const user = { scope: "user", installPath: "/x" };
const project = { scope: "project", projectPath: "/p", installPath: "/y" };
const list = () => listPlugins(h.paths, "acme", { lockWaitMs: 1000, log: (l) => h.logs.push(l) });
const read = () => JSON.parse(fs.readFileSync(settings, "utf8")) as Record<string, unknown>;

describe("plugins from other identities", () => {
  it("names user-scope plugins the settings don't, as off, and keeps everything else", () => {
    writeRegistry({ "foo@m": [user], "bar@m": [project, user], "proj@m": [project], "Own@M": [user] });
    fs.writeFileSync(settings, `${JSON.stringify({ theme: "dark", enabledPlugins: { "own@m": true }, model: "opus" }, null, 2)}\n`);
    assert.deepEqual(list(), { added: ["bar@m", "foo@m"], dropped: [], deferred: false });
    assert.deepEqual(read(), { theme: "dark", enabledPlugins: { "own@m": true, "bar@m": false, "foo@m": false }, model: "opus" });
    assert.deepEqual(Object.keys(read()), ["theme", "enabledPlugins", "model"]);
    assert.ok(fs.readFileSync(settings, "utf8").endsWith("}\n"));
    assert.deepEqual(h.logs, ["xclaude: 2 plugins installed under other logins are in acme's /plugin now, turned off: bar@m, foo@m"]);
    assert.deepEqual(loadState(h.paths).listedPlugins, { acme: ["bar@m", "foo@m"] });

    const mtime = fs.statSync(settings).mtimeMs;
    assert.deepEqual(list(), { added: [], dropped: [], deferred: false }, "a second run finds nothing");
    assert.equal(fs.statSync(settings).mtimeMs, mtime);
    assert.equal(h.logs.length, 1);
  });

  it("creates the settings when there are none, and keeps a file without a final newline that way", () => {
    writeRegistry({ "foo@m": [user] });
    list();
    assert.equal(fs.readFileSync(settings, "utf8"), '{\n  "enabledPlugins": {\n    "foo@m": false\n  }\n}\n');
    assert.equal(fs.statSync(settings).mode & 0o777, 0o600);
    assert.deepEqual(h.logs, ["xclaude: foo@m is installed under another login; acme's /plugin lists it now, turned off"]);

    writeRegistry({ "foo@m": [user], "bar@m": [user] });
    fs.writeFileSync(settings, '{"enabledPlugins":{"foo@m":false}}');
    list();
    assert.ok(fs.readFileSync(settings, "utf8").endsWith("}"));
    assert.deepEqual(read().enabledPlugins, { "foo@m": false, "bar@m": false });
  });

  it("takes out what it added once the plugin is uninstalled, unless it was turned on", () => {
    writeRegistry({ "foo@m": [user], "bar@m": [user] });
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { "mine@m": false } }));
    list();
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { "mine@m": false, "foo@m": false, "bar@m": true } }));
    writeRegistry({});
    assert.deepEqual(list(), { added: [], dropped: ["foo@m"], deferred: false });
    assert.deepEqual(read().enabledPlugins, { "mine@m": false, "bar@m": true });
    assert.deepEqual(loadState(h.paths).listedPlugins, {});
  });

  it("forgets an entry the user took over, without touching the settings", () => {
    writeRegistry({ "foo@m": [user] });
    list();
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { "foo@m": true } }));
    const mtime = fs.statSync(settings).mtimeMs;
    list();
    assert.equal(fs.statSync(settings).mtimeMs, mtime);
    assert.deepEqual(loadState(h.paths).listedPlugins, {});
  });

  it("leaves settings it can't read as expected alone", () => {
    writeRegistry({ "foo@m": [user] });
    for (const text of ["{not json", "[]", '{"enabledPlugins":["foo@m"]}', ""]) {
      fs.writeFileSync(settings, text);
      assert.equal(planPlugins(h.paths, "acme", []), null, JSON.stringify(text));
      list();
      assert.equal(fs.readFileSync(settings, "utf8"), text);
    }
    fs.rmSync(settings);
    const elsewhere = path.join(h.root, "elsewhere.json");
    fs.writeFileSync(elsewhere, "{}");
    fs.symlinkSync(elsewhere, settings);
    list();
    assert.equal(fs.readFileSync(elsewhere, "utf8"), "{}");
    assert.deepEqual(h.logs, []);
  });

  it("does nothing without a readable registry, or for an account whose plugins aren't the store's", () => {
    assert.deepEqual(userPlugins(h.paths), []);
    fs.writeFileSync(path.join(h.S, "plugins", "installed_plugins.json"), "{half");
    assert.equal(userPlugins(h.paths), null);
    list();
    assert.ok(!fs.existsSync(settings));

    writeRegistry({ "foo@m": [user] });
    const solo = h.account("solo");
    fs.mkdirSync(path.join(solo, "plugins"));
    assert.equal(planPlugins(h.paths, "solo", []), null);
    assert.equal(planPlugins(h.paths, "gone", []), null);
  });

  it("skips settings Claude Code wrote after they were read", () => {
    writeRegistry({ "foo@m": [user] });
    fs.writeFileSync(settings, "{}");
    const plan = planPlugins(h.paths, "acme", [])!;
    fs.writeFileSync(settings, '{"theme":"light"}');
    assert.equal(writePlan(plan), false);
    assert.equal(fs.readFileSync(settings, "utf8"), '{"theme":"light"}');
  });

  it("waits for the store lock and defers when it stays busy", () => {
    writeRegistry({ "foo@m": [user] });
    const lock = DirLock.acquire(path.join(h.paths.locks, "store"), STORE_LOCK, { waitMs: 0 })!;
    try {
      assert.deepEqual(listPlugins(h.paths, "acme", { lockWaitMs: 0, log: () => {} }), { added: [], dropped: [], deferred: true });
      assert.ok(!fs.existsSync(settings));
    } finally {
      lock.release();
    }
  });
});
