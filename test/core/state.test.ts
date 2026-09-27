import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type Paths, resolvePaths } from "../../src/core/paths.ts";
import { emptyState, forgetAccount, loadState, recordUse, saveState, updateState } from "../../src/core/state.ts";
import { removeTemp, tempDir } from "../helpers/tmp.ts";

let root: string;
let paths: Paths;
beforeEach(() => {
  root = tempDir();
  paths = resolvePaths({ HOME: root });
});
afterEach(() => removeTemp(root));

describe("state", () => {
  it("reads a missing file as empty", () => {
    assert.deepEqual(loadState(paths), emptyState());
  });

  it("resets a corrupt file to empty", () => {
    fs.mkdirSync(paths.xhome);
    fs.writeFileSync(paths.state, "{not json");
    assert.deepEqual(loadState(paths), emptyState());
    fs.writeFileSync(paths.state, JSON.stringify({ lastAccountByDir: "nope", lastUsedAccount: 3, seenUnknownEntries: { a: [1, "x"] } }));
    assert.deepEqual(loadState(paths), { ...emptyState(), seenUnknownEntries: { a: ["x"] } });
  });

  it("round-trips with mode 0600", () => {
    const s = emptyState();
    s.installedVersion = "1.0.0";
    recordUse(s, "/home/u/code/api", "acme");
    s.seenUnknownEntries.acme = ["foo"];
    saveState(paths, s);
    assert.deepEqual(loadState(paths), s);
    assert.equal(fs.statSync(paths.state).mode & 0o777, 0o600);
  });

  it("records the last account per directory, newest last, with a cap", () => {
    const s = emptyState();
    for (let i = 0; i < 510; i++) recordUse(s, `/d/${i}`, "a");
    recordUse(s, "/d/505", "b");
    const dirs = Object.keys(s.lastAccountByDir);
    assert.equal(dirs.length, 500);
    assert.equal(dirs[0], "/d/10");
    assert.equal(dirs.at(-1), "/d/505");
    assert.equal(s.lastAccountByDir["/d/505"], "b");
    assert.equal(s.lastUsedAccount, "b");
  });

  it("forgets a removed account", () => {
    const s = emptyState();
    recordUse(s, "/x", "acme");
    recordUse(s, "/y", "other");
    recordUse(s, "/z", "acme");
    s.seenUnknownEntries.acme = ["foo"];
    forgetAccount(s, "acme");
    assert.deepEqual(s.lastAccountByDir, { "/y": "other" });
    assert.equal(s.lastUsedAccount, null);
    assert.deepEqual(s.seenUnknownEntries, {});
  });

  it("updateState reads, changes and writes", () => {
    updateState(paths, (s) => recordUse(s, "/x", "acme"));
    updateState(paths, (s) => recordUse(s, "/y", "other"));
    assert.deepEqual(loadState(paths).lastAccountByDir, { "/x": "acme", "/y": "other" });
  });
});
