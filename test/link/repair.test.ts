// Per-entry repair: one fixture per state of the table.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DirLock, STORE_LOCK } from "../../src/core/lock.ts";
import { inspectAccount } from "../../src/link/repair.ts";
import { SHARED_DIRS } from "../../src/link/table.ts";
import { type Home, linkTarget, makeHome } from "../helpers/accounts.ts";
import { reportTiming } from "../helpers/timing.ts";

let h: Home;
let A: string;
beforeEach(() => {
  h = makeHome();
  A = h.account("acme");
});
afterEach(() => h.cleanup());

const states = () => Object.fromEntries(inspectAccount(h.paths, "acme", h.table()).entries.map((e) => [e.name, e.state]));

describe("missing entries", () => {
  it("creates the store entries and links every shared entry", () => {
    const res = h.repair("acme");
    assert.deepEqual({ ...res, names: [] }, { clean: true, busy: false, problems: [], names: [] });
    for (const e of SHARED_DIRS.filter((e) => e !== "memory")) {
      assert.equal(linkTarget(path.join(A, e)), path.join(h.S, e), e);
      assert.ok(fs.statSync(path.join(h.S, e)).isDirectory(), e);
      assert.equal(fs.statSync(path.join(h.S, e)).mode & 0o777, 0o700, e);
    }
    assert.equal(linkTarget(path.join(A, "history.jsonl")), path.join(h.S, "history.jsonl"));
    const hist = fs.lstatSync(path.join(h.S, "history.jsonl"));
    assert.ok(hist.isFile());
    assert.equal(hist.size, 0);
    assert.equal(hist.mode & 0o777, 0o600);
  });

  it("links memory only while the store has one", () => {
    h.repair("acme");
    assert.equal(fs.existsSync(path.join(A, "memory")), false);
    fs.mkdirSync(path.join(h.S, "memory"));
    h.repair("acme");
    assert.equal(linkTarget(path.join(A, "memory")), path.join(h.S, "memory"));
  });

  it("leaves an account's own memory alone while the store has none", () => {
    fs.mkdirSync(path.join(A, "memory"));
    fs.writeFileSync(path.join(A, "memory", "note.md"), "mine");
    const res = h.repair("acme");
    assert.equal(res.clean, true);
    assert.equal(states().memory, "optional-absent");
    assert.equal(fs.readFileSync(path.join(A, "memory", "note.md"), "utf8"), "mine");
  });

  it("takes no lock when everything is already correct", () => {
    h.repair("acme");
    fs.rmSync(h.paths.locks, { recursive: true, force: true });
    const res = h.repair("acme");
    assert.equal(res.clean, true);
    assert.equal(fs.existsSync(h.paths.locks), false);
  });

  it("recreates a missing account dir", () => {
    fs.rmdirSync(A);
    const res = h.repair("acme");
    assert.equal(res.clean, true);
    assert.equal(fs.statSync(A).mode & 0o777, 0o700);
    assert.match(h.logs.join("\n"), /config dir was missing/);
  });
});

describe("existing links", () => {
  it("accepts a link to ~/.claude/E and one to its real path", () => {
    const dotfiles = path.join(h.root, "dotfiles", "skills");
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.mkdirSync(h.S, { recursive: true });
    fs.symlinkSync(dotfiles, path.join(h.S, "skills"));
    fs.mkdirSync(path.join(h.S, "agents"));
    fs.symlinkSync(path.join(h.S, "agents"), path.join(A, "agents"));
    h.repair("acme");
    assert.equal(linkTarget(path.join(A, "skills")), dotfiles, "new links point at the real path, never at a link");
    assert.equal(linkTarget(path.join(A, "agents")), path.join(h.S, "agents"));
    // The literal ~/.claude/skills form is accepted too.
    fs.unlinkSync(path.join(A, "skills"));
    fs.symlinkSync(path.join(h.S, "skills"), path.join(A, "skills"));
    assert.equal(states().skills, "ok");
    assert.equal(h.repair("acme").clean, true);
  });

  it("reports a link pointing elsewhere and leaves it at launch", () => {
    const elsewhere = path.join(h.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(A, "skills"));
    fs.symlinkSync(path.join(h.root, "gone"), path.join(A, "plans"));
    const res = h.repair("acme");
    assert.equal(res.clean, false);
    assert.deepEqual(res.problems.map((p) => p.entry).sort(), ["plans", "skills"]);
    assert.match(res.problems[0]!.message, /xclaude doctor --fix/);
    assert.equal(linkTarget(path.join(A, "skills")), elsewhere);
  });

  it("replaces a link pointing elsewhere with doctor --fix", () => {
    const elsewhere = path.join(h.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "keep.md"), "x");
    fs.symlinkSync(elsewhere, path.join(A, "skills"));
    fs.symlinkSync(path.join(h.root, "gone"), path.join(A, "plans"));
    const res = h.repair("acme", { replaceWrongLinks: true });
    assert.equal(res.clean, true);
    assert.equal(linkTarget(path.join(A, "skills")), path.join(h.S, "skills"));
    assert.equal(linkTarget(path.join(A, "plans")), path.join(h.S, "plans"));
    assert.equal(fs.readFileSync(path.join(elsewhere, "keep.md"), "utf8"), "x", "the old target is untouched");
    assert.match(h.logs.join("\n"), /skills pointed to .*elsewhere; relinked/);
  });

  it("recreates a store entry that disappeared under a correct link", () => {
    h.repair("acme");
    fs.rmdirSync(path.join(h.S, "plans"));
    fs.rmSync(path.join(h.S, "history.jsonl"));
    assert.equal(states().plans, "store-missing");
    assert.equal(h.repair("acme").clean, true);
    assert.ok(fs.statSync(path.join(h.S, "plans")).isDirectory());
    assert.ok(fs.statSync(path.join(h.S, "history.jsonl")).isFile());
  });
});

describe("wrong types", () => {
  it("reports a file where a directory belongs, and the reverse", () => {
    fs.writeFileSync(path.join(A, "skills"), "not a dir");
    fs.mkdirSync(path.join(A, "history.jsonl"));
    const res = h.repair("acme");
    assert.equal(res.clean, false);
    const byEntry = Object.fromEntries(res.problems.map((p) => [p.entry, p.message]));
    assert.match(byEntry.skills!, /is a file where a directory link belongs/);
    assert.match(byEntry["history.jsonl"]!, /is a directory where a file link belongs/);
    assert.equal(fs.readFileSync(path.join(A, "skills"), "utf8"), "not a dir");
  });

  it("reports a store entry of the wrong type without linking to it", () => {
    fs.mkdirSync(h.S, { recursive: true });
    fs.writeFileSync(path.join(h.S, "skills"), "oops");
    const res = h.repair("acme");
    assert.match(res.problems.find((p) => p.entry === "skills")!.message, /~\/\.claude\/skills isn't a directory/);
    assert.equal(fs.existsSync(path.join(A, "skills")), false);
  });
});

describe("unsharing", () => {
  it("turns a share.remove entry into an empty real directory, keeping the store copy", () => {
    h.repair("acme");
    fs.writeFileSync(path.join(h.S, "skills", "shared.md"), "stays");
    h.config.share.remove = ["skills"];
    const res = h.repair("acme");
    assert.equal(res.clean, true);
    const st = fs.lstatSync(path.join(A, "skills"));
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.deepEqual(fs.readdirSync(path.join(A, "skills")), []);
    assert.equal(fs.readFileSync(path.join(h.S, "skills", "shared.md"), "utf8"), "stays");
    assert.match(h.logs.join("\n"), /skills is no longer shared/);
  });

  it("turns an unshared history.jsonl into an empty 0600 file", () => {
    h.repair("acme");
    fs.writeFileSync(path.join(h.S, "history.jsonl"), '{"display":"x"}\n');
    h.config.share.remove = ["history.jsonl"];
    h.repair("acme");
    const st = fs.lstatSync(path.join(A, "history.jsonl"));
    assert.ok(st.isFile());
    assert.equal(st.size, 0);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(h.S, "history.jsonl"), "utf8"), '{"display":"x"}\n');
  });

  it("follows a built-in entry switched to per account", () => {
    h.repair("acme");
    h.switches.shareSkills = false;
    h.switches.shareSessions = false;
    assert.equal(h.repair("acme").clean, true);
    for (const e of ["skills", "sessions"]) {
      const st = fs.lstatSync(path.join(A, e));
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), e);
    }
    assert.equal(linkTarget(path.join(A, "projects")), path.join(h.S, "projects"));
    // A fresh account under the switch never links them at all.
    const B = h.account("b");
    h.repair("b");
    assert.equal(fs.existsSync(path.join(B, "skills")), false);
    assert.equal(linkTarget(path.join(B, "projects")), path.join(h.S, "projects"));
  });

  it("shares share.add directories and unshares them once removed", () => {
    h.config.share.add = ["new-dir"];
    h.repair("acme");
    assert.equal(linkTarget(path.join(A, "new-dir")), path.join(h.S, "new-dir"));
    h.config.share.add = [];
    h.repair("acme");
    assert.equal(fs.lstatSync(path.join(A, "new-dir")).isSymbolicLink(), false);
  });

  it("never touches a hand-made link for a never-shared entry", () => {
    fs.mkdirSync(h.S, { recursive: true });
    fs.writeFileSync(path.join(h.S, "settings.json"), "{}");
    fs.symlinkSync(path.join(h.S, "settings.json"), path.join(A, "settings.json"));
    h.repair("acme");
    assert.equal(linkTarget(path.join(A, "settings.json")), path.join(h.S, "settings.json"));
  });
});

describe("concurrency", () => {
  it("skips repairs when the store lock stays busy (the launch rule)", () => {
    const lock = DirLock.acquire(path.join(h.paths.locks, "store"), STORE_LOCK, { waitMs: 0 })!;
    try {
      const res = h.repair("acme", { lockWaitMs: 200 });
      assert.equal(res.busy, true);
      assert.equal(fs.existsSync(path.join(A, "projects")), false);
    } finally {
      lock.release();
    }
    assert.equal(h.repair("acme", { lockWaitMs: 200 }).clean, true);
  });

  it("takes over a stale store lock", () => {
    const lockDir = path.join(h.paths.locks, "store");
    fs.mkdirSync(lockDir, { recursive: true });
    const old = new Date(Date.now() - STORE_LOCK.staleMs - 1_000);
    fs.utimesSync(lockDir, old, old);
    assert.equal(h.repair("acme", { lockWaitMs: 200 }).clean, true);
  });

  it("counts a link created in between with the right target as success", () => {
    const original = fs.symlinkSync;
    let raced = false;
    fs.symlinkSync = ((target: string, p: string) => {
      if (!raced && path.basename(p) === "plans") {
        raced = true;
        original(target, p); // someone else was faster
        throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      }
      original(target, p);
    }) as typeof fs.symlinkSync;
    try {
      assert.equal(h.repair("acme").clean, true);
    } finally {
      fs.symlinkSync = original;
    }
    assert.ok(raced);
    assert.equal(linkTarget(path.join(A, "plans")), path.join(h.S, "plans"));
  });

  it("removes temp links and files left by an interrupted swap", () => {
    fs.symlinkSync("/nowhere", path.join(A, ".xclaude-link-skills-1-2-3"));
    fs.writeFileSync(path.join(A, ".xclaude-unshare-history.jsonl-1-2-3"), "");
    assert.equal(h.repair("acme").clean, true);
    assert.deepEqual(fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-")), []);
  });
});

describe("fast path", () => {
  it("checks a correct account quickly", (t) => {
    h.repair("acme");
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      h.repair("acme", { lockWaitMs: 0 });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    reportTiming(t, "link engine fast path (median of 20)", samples[10]!, 5);
  });
});
