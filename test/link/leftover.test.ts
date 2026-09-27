// Leftover folders of removed accounts: what counts as one, and what rm keeps.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { resolvePaths } from "../../src/core/paths.ts";
import { keepOnlyLinks, leftoverNames, strayFolders } from "../../src/link/leftover.ts";
import { shareTable } from "../../src/link/table.ts";
import { SWITCHES } from "../../src/switches.ts";
import { removeTemp, tempDir } from "../helpers/tmp.ts";

let root: string;
beforeEach(() => {
  root = tempDir();
});
afterEach(() => removeTemp(root));

const setup = () => {
  const paths = resolvePaths({ HOME: root });
  fs.mkdirSync(paths.accounts, { recursive: true });
  fs.mkdirSync(path.join(paths.store, "projects"), { recursive: true });
  return paths;
};
const table = () => shareTable(defaultConfig(), SWITCHES);

describe("strayFolders", () => {
  it("tells leftovers from folders that hold more, strays and links", () => {
    const paths = setup();
    const config = defaultConfig();
    config.accounts.acme = { model: null, effort: null, args: [] };
    const make = (name: string) => fs.mkdirSync(path.join(paths.accounts, name));
    for (const name of ["acme", "old", "busy", "work.bak"]) make(name);
    fs.symlinkSync(path.join(paths.store, "projects"), path.join(paths.accounts, "old", "projects"));
    fs.writeFileSync(path.join(paths.accounts, "old", ".DS_Store"), "");
    fs.writeFileSync(path.join(paths.accounts, "busy", ".credentials.json"), "{}");
    fs.symlinkSync(root, path.join(paths.accounts, "linked"));
    fs.mkdirSync(path.join(paths.accounts, "gone.lock"));
    const kinds = Object.fromEntries(strayFolders(paths, config).map((f) => [f.name, [f.kind, f.entries]]));
    assert.deepEqual(kinds, {
      busy: ["content", [".credentials.json"]],
      linked: ["link", []],
      old: ["leftover", []],
      "work.bak": ["stray", []],
    });
    assert.deepEqual(leftoverNames(paths, config), ["old"]);
  });
});

describe("keepOnlyLinks", () => {
  it("keeps the links and the account's own content under shared names, drops the rest", () => {
    const paths = setup();
    const dir = path.join(paths.accounts, "acme");
    fs.mkdirSync(path.join(dir, "skills", "mine"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "mine", "SKILL.md"), "mine");
    fs.mkdirSync(path.join(dir, "plans")); // empty: nothing to keep
    fs.symlinkSync(path.join(paths.store, "projects"), path.join(dir, "projects"));
    fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
    fs.mkdirSync(path.join(dir, "backups"));
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "stub");
    assert.deepEqual(keepOnlyLinks(dir, table()), { kept: true, content: ["skills"] });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["projects", "skills"]);
    assert.ok(fs.existsSync(path.join(paths.store, "projects")), "the store is untouched");
  });

  it("removes a folder left with nothing, and refuses a symlinked one", () => {
    const paths = setup();
    const dir = path.join(paths.accounts, "acme");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
    assert.deepEqual(keepOnlyLinks(dir, table()), { kept: false, content: [] });
    assert.equal(fs.existsSync(dir), false);
    fs.symlinkSync(paths.store, dir);
    assert.throws(() => keepOnlyLinks(dir, table()), /is a symlink/);
    assert.ok(fs.existsSync(path.join(paths.store, "projects")));
  });
});
