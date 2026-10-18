// Settings from ~/.claude: merged into each account's settings.json, three-way.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeIfUnchanged } from "../../src/core/fsutil.ts";
import { DirLock, STORE_LOCK } from "../../src/core/lock.ts";
import {
  basePath,
  inheritSettings,
  inheritStatus,
  type JsonObject,
  mergeSettings,
  planInherit,
  resetInherit,
  stopInheriting,
} from "../../src/link/inherit.ts";
import { type Home, makeHome } from "../helpers/accounts.ts";

const M0: JsonObject = {
  permissions: { allow: ["Read", "Bash(git status)"], deny: ["Bash(git push *)"], defaultMode: "auto" },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "notify" }] }] },
  env: { OTEL: "x" },
  theme: "dark",
};

describe("mergeSettings", () => {
  it("a first merge into an empty account takes everything but the per-account keys", () => {
    const r = mergeSettings(undefined, { ...M0, enabledPlugins: { "a@m": true }, apiKeyHelper: "/k" }, {});
    assert.deepEqual(r.next, { permissions: M0.permissions, hooks: M0.hooks, theme: "dark" });
    assert.deepEqual(r.base, r.next);
  });

  it("a first merge joins lists and keeps the account's own single values, reporting them", () => {
    const r = mergeSettings(undefined, M0, { permissions: { allow: ["Bash(ls)"] }, theme: "light", model: "sonnet" });
    assert.deepEqual(r.next.permissions, { allow: ["Bash(ls)", "Read", "Bash(git status)"], deny: ["Bash(git push *)"], defaultMode: "auto" });
    assert.equal(r.next.theme, "light");
    assert.equal(r.next.model, "sonnet");
    assert.deepEqual(r.kept, ["theme"]);
  });

  it("brings ~/.claude's additions and deletions, and keeps the account's", () => {
    const first = mergeSettings(undefined, M0, {});
    const account = { ...first.next, permissions: { ...(first.next.permissions as JsonObject), allow: ["Bash(git status)", "Bash(make)"] } };
    const main = { ...M0, permissions: { ...(M0.permissions as JsonObject), allow: ["Read", "Grep"] } };
    const r = mergeSettings(first.base, main, account);
    assert.deepEqual((r.next.permissions as JsonObject).allow, ["Bash(make)", "Grep"]);
  });

  it("leaves the account exactly as it is while ~/.claude doesn't change", () => {
    const first = mergeSettings(undefined, M0, {});
    const account = { ...first.next, theme: "light", permissions: { allow: [] } };
    assert.deepEqual(mergeSettings(first.base, M0, account), { next: account, base: first.base, kept: [] });
  });

  it("drops a whole list ~/.claude dropped, but not what the account added to it", () => {
    const first = mergeSettings(undefined, M0, {});
    const account = { ...first.next, permissions: { ...(first.next.permissions as JsonObject), deny: ["Bash(git push *)", "Bash(rm -rf *)"] } };
    const r = mergeSettings(first.base, { ...M0, permissions: { allow: ["Read", "Bash(git status)"], defaultMode: "auto" } }, account);
    assert.deepEqual((r.next.permissions as JsonObject).deny, ["Bash(rm -rf *)"]);
  });

  it("a single value follows ~/.claude until the account changes it", () => {
    const first = mergeSettings(undefined, M0, {});
    const account = { ...first.next, permissions: { ...(first.next.permissions as JsonObject), defaultMode: "acceptEdits" } };
    const r = mergeSettings(first.base, { ...M0, permissions: { ...(M0.permissions as JsonObject), defaultMode: "plan" }, theme: "light" }, account);
    assert.equal((r.next.permissions as JsonObject).defaultMode, "acceptEdits");
    assert.equal(r.next.theme, "light");
    assert.deepEqual(r.kept, ["permissions.defaultMode"]);
  });

  it("replaces a hook ~/.claude changed and keeps the account's own", () => {
    const h0 = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.py" }] }] } };
    const first = mergeSettings(undefined, h0, { hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "mine.sh" }] }] } });
    const h1 = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.py", timeout: 5 }] }] } };
    assert.deepEqual((mergeSettings(first.base, h1, first.next).next.hooks as JsonObject).PreToolUse, [
      { matcher: "Edit", hooks: [{ type: "command", command: "mine.sh" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: "guard.py", timeout: 5 }] },
    ]);
  });

  it("is idempotent, so a merge repeated after a crash changes nothing more", () => {
    const first = mergeSettings(undefined, M0, { theme: "light" });
    const main = { ...M0, permissions: { allow: ["Grep"] } };
    const once = mergeSettings(first.base, main, first.next);
    assert.deepEqual(mergeSettings(first.base, main, once.next).next, once.next);
  });

  it("merging against an empty ~/.claude takes back what the account didn't change", () => {
    const first = mergeSettings(undefined, M0, { permissions: { allow: ["Bash(ls)"] } });
    assert.deepEqual(mergeSettings(first.base, {}, first.next).next, { permissions: { allow: ["Bash(ls)"] } });
  });

  it("doesn't count a different key order as a change", () => {
    assert.deepEqual(mergeSettings({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }, { a: { x: 1, y: 2 } }).kept, []);
  });
});

let h: Home;
let settings: string;
let mainFile: string;
beforeEach(() => {
  h = makeHome();
  h.account("acme");
  h.repair("acme");
  settings = path.join(h.paths.xhome, "accounts", "acme", "settings.json");
  mainFile = path.join(h.S, "settings.json");
});
afterEach(() => h.cleanup());

const merge = () => inheritSettings(h.paths, "acme", { lockWaitMs: 1000, log: (l) => h.logs.push(l) });
const read = () => JSON.parse(fs.readFileSync(settings, "utf8")) as JsonObject;
const writeMain = (s: JsonObject) => fs.writeFileSync(mainFile, `${JSON.stringify(s, null, 2)}\n`);

describe("inheritSettings", () => {
  it("merges ~/.claude/settings.json into the account and saves the base", () => {
    writeMain(M0);
    fs.writeFileSync(settings, `${JSON.stringify({ enabledPlugins: { "own@m": true }, model: "opus" }, null, 2)}\n`);
    const before = fs.readFileSync(mainFile, "utf8");
    assert.deepEqual(merge(), { changed: ["permissions", "hooks", "theme"], kept: [], deferred: false });
    assert.deepEqual(read(), { enabledPlugins: { "own@m": true }, model: "opus", permissions: M0.permissions, hooks: M0.hooks, theme: "dark" });
    assert.equal(fs.readFileSync(mainFile, "utf8"), before, "~/.claude/settings.json is never written");
    assert.deepEqual(JSON.parse(fs.readFileSync(basePath(h.paths, "acme"), "utf8")), { permissions: M0.permissions, hooks: M0.hooks, theme: "dark" });
    assert.equal(fs.statSync(basePath(h.paths, "acme")).mode & 0o777, 0o600);
    assert.deepEqual(h.logs, [
      "xclaude: acme takes ~/.claude/settings.json now (permissions, hooks, theme); its own changes stay. Turn that off with: xclaude set acme --inherit off",
    ]);

    const mtime = fs.statSync(settings).mtimeMs;
    assert.deepEqual(merge(), { changed: [], kept: [], deferred: false }, "a second run finds nothing");
    assert.equal(fs.statSync(settings).mtimeMs, mtime);
    assert.equal(h.logs.length, 1);
  });

  it("brings later changes and keeps the account's own", () => {
    writeMain(M0);
    merge();
    fs.writeFileSync(settings, JSON.stringify({ ...read(), theme: "light", permissions: { allow: ["Read", "Bash(make)"], deny: ["Bash(git push *)"], defaultMode: "auto" } }));
    writeMain({ ...M0, theme: "dark-daltonized", permissions: { allow: ["Read", "Bash(git status)", "Grep"], defaultMode: "auto" } });
    h.logs.length = 0;
    assert.deepEqual(merge(), { changed: ["permissions"], kept: ["theme"], deferred: false });
    assert.deepEqual(read().permissions, { allow: ["Read", "Bash(make)", "Grep"], defaultMode: "auto" });
    assert.equal(read().theme, "light");
    assert.ok(fs.readFileSync(settings, "utf8").endsWith("}"), "a file without a final newline stays that way");
    assert.deepEqual(h.logs, [
      "xclaude: acme took ~/.claude/settings.json's changes to permissions",
      "xclaude: acme keeps its own theme, which ~/.claude/settings.json sets differently",
    ]);
  });

  it("does nothing at all while ~/.claude has nothing to give", () => {
    assert.deepEqual(merge(), { changed: [], kept: [], deferred: false });
    writeMain({ env: { A: "1" }, enabledPlugins: { "x@m": true } });
    merge();
    assert.ok(!fs.existsSync(settings));
    assert.ok(!fs.existsSync(h.paths.inherit));
    assert.deepEqual(h.logs, []);
  });

  it("merges from scratch when the account's settings.json is gone, whatever the base says", () => {
    writeMain(M0);
    merge();
    fs.writeFileSync(settings, JSON.stringify({ theme: "dark" }));
    merge();
    assert.equal(read().permissions, undefined, "the account deleted them, and that stays");
    fs.rmSync(settings);
    merge();
    assert.deepEqual(read().permissions, M0.permissions);
  });

  it("reports a broken ~/.claude/settings.json and leaves the account alone", () => {
    fs.writeFileSync(mainFile, "{half");
    fs.writeFileSync(settings, "{}");
    merge();
    assert.equal(fs.readFileSync(settings, "utf8"), "{}");
    assert.deepEqual(h.logs, ["xclaude: ~/.claude/settings.json isn't valid JSON, so acme keeps its settings as they are"]);
    assert.ok(!fs.existsSync(basePath(h.paths, "acme")));
  });

  it("leaves settings it can't read as expected alone", () => {
    writeMain(M0);
    for (const text of ["{not json", "[]", ""]) {
      fs.writeFileSync(settings, text);
      assert.equal(planInherit(h.paths, "acme"), null, JSON.stringify(text));
      merge();
      assert.equal(fs.readFileSync(settings, "utf8"), text);
    }
    fs.rmSync(settings);
    const elsewhere = path.join(h.root, "elsewhere.json");
    fs.writeFileSync(elsewhere, "{}");
    fs.symlinkSync(elsewhere, settings);
    merge();
    assert.equal(fs.readFileSync(elsewhere, "utf8"), "{}");
    assert.equal(planInherit(h.paths, "gone"), null);
    assert.deepEqual(h.logs, []);
  });

  it("follows a ~/.claude/settings.json that is a link", () => {
    const dotfiles = path.join(h.root, "dotfiles.json");
    fs.writeFileSync(dotfiles, JSON.stringify({ theme: "dark" }));
    fs.symlinkSync(dotfiles, mainFile);
    merge();
    assert.deepEqual(read(), { theme: "dark" });
  });

  it("waits for the store lock and defers when it stays busy", () => {
    writeMain(M0);
    const lock = DirLock.acquire(path.join(h.paths.locks, "store"), STORE_LOCK, { waitMs: 0 })!;
    try {
      assert.deepEqual(inheritSettings(h.paths, "acme", { lockWaitMs: 0, log: () => {} }), { changed: [], kept: [], deferred: true });
      assert.ok(!fs.existsSync(settings));
      assert.ok(!fs.existsSync(basePath(h.paths, "acme")));
    } finally {
      lock.release();
    }
  });

  it("writes nothing over settings Claude Code wrote after they were read", () => {
    writeMain(M0);
    fs.writeFileSync(settings, "{}");
    const plan = planInherit(h.paths, "acme");
    assert.ok(plan && !("problem" in plan) && plan.text !== null);
    fs.writeFileSync(settings, '{"model":"opus"}');
    assert.equal(writeIfUnchanged(plan.file, plan.text, plan.seen), false);
    assert.equal(fs.readFileSync(settings, "utf8"), '{"model":"opus"}');
  });
});

describe("stopping and starting over", () => {
  it("--inherit off takes back what wasn't changed and forgets the base", () => {
    writeMain(M0);
    fs.writeFileSync(settings, JSON.stringify({ model: "opus", permissions: { allow: ["Bash(ls)"] } }));
    merge();
    fs.writeFileSync(settings, JSON.stringify({ ...read(), theme: "light" }));
    h.logs.length = 0;
    assert.equal(stopInheriting(h.paths, "acme", { lockWaitMs: 1000, log: (l) => h.logs.push(l) }), true);
    assert.deepEqual(read(), { model: "opus", permissions: { allow: ["Bash(ls)"] }, theme: "light" });
    assert.ok(!fs.existsSync(basePath(h.paths, "acme")));
    assert.deepEqual(h.logs, ["xclaude: took back what acme had from ~/.claude/settings.json: permissions, hooks"]);
  });

  it("--inherit reset brings back what the account deleted", () => {
    writeMain(M0);
    merge();
    fs.writeFileSync(settings, JSON.stringify({ theme: "dark" }));
    merge();
    assert.equal(read().hooks, undefined);
    resetInherit(h.paths, "acme", { lockWaitMs: 1000, log: () => {} });
    assert.deepEqual(read().hooks, M0.hooks);
  });

  it("doctor's status: what's pending, and what the account keeps its own", () => {
    writeMain(M0);
    fs.writeFileSync(settings, JSON.stringify({ theme: "light" }));
    assert.deepEqual(inheritStatus(h.paths, "acme", M0), { pending: ["permissions", "hooks"], own: ["theme"] });
    merge();
    assert.deepEqual(inheritStatus(h.paths, "acme", M0), { pending: [], own: ["theme"] });
  });
});
