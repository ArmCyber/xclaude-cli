// Merge safety: a running session is never split, a failed merge leaves the
// account as it was, and odd store layouts are refused. Each test reproduces a
// finding from the link-engine review.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fsops } from "../../src/core/fsutil.ts";
import { asideName } from "../../src/link/merge.ts";
import { isShareableDirName, shareTable } from "../../src/link/table.ts";
import { type Home, linkTarget, makeHome } from "../helpers/accounts.ts";
import { readTree, writeTree } from "../helpers/tmp.ts";

let h: Home;
let A: string;
beforeEach(() => {
  h = makeHome();
  A = h.account("acme");
});
afterEach(() => h.cleanup());

const leftovers = () => fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-"));

/** Every regular file's content under a directory, sorted. */
function contents(dir: string): string[] {
  return Object.entries(readTree(dir))
    .filter(([k, v]) => !k.endsWith("/") && !v.startsWith("-> "))
    .map(([, v]) => v)
    .sort();
}

describe("a running session during a merge", () => {
  it("keeps appending to the same transcript across the swap: no split, no conflict copy", () => {
    writeTree(path.join(A, "projects"), { "p/abc.jsonl": "line1\nline2\n" });
    const original = fs.symlinkSync;
    fs.symlinkSync = ((target: string, p: string) => {
      original(target, p);
      if (p === path.join(A, "projects")) {
        // The session appends by path right after the swap, before the aside is emptied.
        fs.appendFileSync(path.join(A, "projects", "p", "abc.jsonl"), "line3\n");
      }
    }) as typeof fs.symlinkSync;
    try {
      assert.deepEqual(h.repair("acme").problems, []);
    } finally {
      fs.symlinkSync = original;
    }
    assert.deepEqual(readTree(path.join(h.S, "projects")), { "p/": "/", "p/abc.jsonl": "line1\nline2\nline3\n" });
    assert.deepEqual(leftovers(), []);
  });

  it("appends made after the link pass but before the swap land in the store too", () => {
    writeTree(path.join(A, "projects"), { "p/abc.jsonl": "line1\n" });
    const original = fs.renameSync;
    let appended = false;
    fs.renameSync = ((from: string, to: string) => {
      if (!appended && from === path.join(A, "projects")) {
        appended = true;
        fs.appendFileSync(path.join(A, "projects", "p", "abc.jsonl"), "line2\n"); // just before the swap
        fs.writeFileSync(path.join(A, "projects", "p", "new.jsonl"), "brand new\n"); // created in the window
      }
      original(from, to);
    }) as typeof fs.renameSync;
    try {
      assert.deepEqual(h.repair("acme").problems, []);
    } finally {
      fs.renameSync = original;
    }
    assert.deepEqual(readTree(path.join(h.S, "projects")), { "p/": "/", "p/abc.jsonl": "line1\nline2\n", "p/new.jsonl": "brand new\n" });
  });
});

describe("a merge that fails leaves the account as it was", () => {
  const tree = {
    "alpha": { link: "/repo/alpha" },
    "beta": { link: "/repo/beta" },
    "group/g1": { link: "/repo/g1" },
    "group/sub/deep.md": "deep",
    "zzz-real.md": "real",
  };

  it("undoes everything on EXDEV, symlinks and empty dirs included", () => {
    writeTree(path.join(A, "skills"), tree);
    const before = readTree(path.join(A, "skills"));
    const original = fsops.link;
    fsops.link = () => {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    };
    let res;
    try {
      res = h.repair("acme");
    } finally {
      fsops.link = original;
    }
    assert.match(res.problems.find((p) => p.entry === "skills")!.message, /different filesystems/);
    const st = fs.lstatSync(path.join(A, "skills"));
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.deepEqual(readTree(path.join(A, "skills")), before);
    assert.deepEqual(fs.readdirSync(path.join(h.S, "skills")), [], "nothing was left in the store");
    assert.deepEqual(leftovers(), []);
  });

  it("undoes everything when the store entry isn't writable", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores permissions");
      return;
    }
    writeTree(path.join(A, "skills"), tree);
    const before = readTree(path.join(A, "skills"));
    fs.mkdirSync(path.join(h.S, "skills"), { recursive: true });
    fs.writeFileSync(path.join(h.S, "skills", "existing.md"), "dotfiles");
    fs.chmodSync(path.join(h.S, "skills"), 0o555);
    let res;
    try {
      res = h.repair("acme");
    } finally {
      fs.chmodSync(path.join(h.S, "skills"), 0o755);
    }
    assert.match(res.problems.find((p) => p.entry === "skills")!.message, /can't be merged, left as it was: EACCES.*fix the permissions, or stop sharing skills with share\.remove/);
    assert.deepEqual(readTree(path.join(A, "skills")), before);
    assert.deepEqual(fs.readdirSync(path.join(h.S, "skills")), ["existing.md"]);
    assert.deepEqual(leftovers(), []);
  });

  it("puts the directory back when the link can't be made", () => {
    writeTree(path.join(A, "plans"), { "p.md": "plan" });
    const original = fs.symlinkSync;
    fs.symlinkSync = ((target: string, p: string) => {
      if (p === path.join(A, "plans")) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
      original(target, p);
    }) as typeof fs.symlinkSync;
    let res;
    try {
      res = h.repair("acme");
    } finally {
      fs.symlinkSync = original;
    }
    assert.match(res.problems.find((p) => p.entry === "plans")!.message, /repair failed: EIO/);
    assert.equal(fs.readFileSync(path.join(A, "plans", "p.md"), "utf8"), "plan");
    assert.deepEqual(leftovers(), []);
    assert.deepEqual(fs.readdirSync(path.join(h.S, "plans")), [], "the link pass was undone too");
    assert.equal(h.repair("acme").clean, true, "the next run merges it");
    assert.equal(fs.readFileSync(path.join(h.S, "plans", "p.md"), "utf8"), "plan");
  });
});

describe("store entries that point into an account dir", () => {
  it("are refused instead of making self-referencing links", () => {
    writeTree(path.join(A, "skills"), { "mine.md": "mine" });
    fs.writeFileSync(path.join(A, "history.jsonl"), '{"display":"x","timestamp":1}\n');
    fs.mkdirSync(h.S, { recursive: true });
    fs.symlinkSync(path.join(A, "skills"), path.join(h.S, "skills"));
    fs.symlinkSync(path.join(A, "history.jsonl"), path.join(h.S, "history.jsonl"));
    const res = h.repair("acme");
    for (const entry of ["skills", "history.jsonl"]) {
      assert.match(res.problems.find((p) => p.entry === entry)!.message, /resolves into .*inside an account dir/, entry);
    }
    assert.equal(fs.readFileSync(path.join(A, "skills", "mine.md"), "utf8"), "mine");
    assert.ok(!fs.lstatSync(path.join(A, "skills")).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(A, "history.jsonl")).isFile());
    assert.deepEqual(leftovers(), []);
  });
});

describe("interrupted merges of entries that are no longer shared", () => {
  it("move the content back into the account's own directory", () => {
    h.repair("acme");
    writeTree(path.join(A, asideName("skills")), { "mine.md": "mine" });
    h.config.share.remove = ["skills"];
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.equal(fs.readFileSync(path.join(A, "skills", "mine.md"), "utf8"), "mine");
    assert.ok(!fs.lstatSync(path.join(A, "skills")).isSymbolicLink());
    assert.deepEqual(leftovers(), []);
  });

  it("merge history lines back into the account's own history", () => {
    h.repair("acme");
    fs.writeFileSync(path.join(A, asideName("history.jsonl")), '{"display":"old","timestamp":1}\n');
    h.config.share.remove = ["history.jsonl"];
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.equal(fs.readFileSync(path.join(A, "history.jsonl"), "utf8"), '{"display":"old","timestamp":1}\n');
    assert.ok(fs.lstatSync(path.join(A, "history.jsonl")).isFile());
    assert.deepEqual(leftovers(), []);
  });
});

describe("share.add names", () => {
  it("refuses never-shared entries in any case, and file-like names", () => {
    for (const bad of ["jobs", "Jobs", "DAEMON", "Settings.json", ".credentials.json", "History.jsonl", "claude.md", "loop.md", ".session_ingress_token", "notes.txt", "backups", "Cache", "ide", "logs", "storage-v2", "state"]) {
      assert.equal(isShareableDirName(bad), false, bad);
    }
    for (const ok of ["output-styles", "my-dir", "skills", "new-thing"]) assert.equal(isShareableDirName(ok), true, ok);
    h.config.share.add = ["Jobs", "loop.md", "backups", "new-thing"];
    const t = shareTable(h.config, h.switches);
    assert.deepEqual(t.refused, ["Jobs", "loop.md", "backups"]);
    assert.ok(t.dirs.includes("new-thing") && !t.dirs.includes("Jobs") && !t.dirs.includes("backups"));
  });
});

describe("the store lock", () => {
  it("stops the repair when another process takes the lock over", () => {
    const lockDir = path.join(h.paths.locks, "store");
    const original = fs.symlinkSync;
    let stolen = false;
    fs.symlinkSync = ((target: string, p: string) => {
      original(target, p);
      if (!stolen) {
        stolen = true;
        fs.rmdirSync(lockDir);
        fs.mkdirSync(lockDir);
        const later = new Date(Date.now() + 5_000);
        fs.utimesSync(lockDir, later, later);
      }
    }) as typeof fs.symlinkSync;
    let res;
    try {
      res = h.repair("acme");
    } finally {
      fs.symlinkSync = original;
    }
    assert.ok(res.problems.some((p) => /another xclaude took over the repair lock/.test(p.message)));
    assert.equal(fs.existsSync(lockDir), true, "the new holder's lock is left alone");
    fs.rmdirSync(lockDir);
    assert.equal(h.repair("acme").clean, true);
    assert.equal(linkTarget(path.join(A, "plugins")), path.join(h.S, "plugins"));
  });
});

/** Makes the store lock someone else's, as a process that judged it stale would. */
function stealLock(): void {
  const dir = path.join(h.paths.locks, "store");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(dir, later, later);
}

describe("a repair that loses its lock (review finding: suspended past the stale time)", () => {
  it("never reads through a symlinked aside, and removes it", () => {
    h.repair("acme");
    writeTree(path.join(h.S, "projects"), { "p/b-conversation.jsonl": "account b's words" });
    fs.symlinkSync(path.join(h.S, "projects"), path.join(A, asideName("projects")));
    assert.equal(h.repair("acme").clean, true);
    assert.equal(fs.readFileSync(path.join(h.S, "projects", "p", "b-conversation.jsonl"), "utf8"), "account b's words");
    assert.deepEqual(leftovers(), []);
  });

  it("stops without undoing when the lock is taken over during the link pass", () => {
    writeTree(path.join(A, "projects"), { "p/one.jsonl": "1", "p/two.jsonl": "2", "q/three.jsonl": "3" });
    writeTree(path.join(h.S, "projects"), { "p/b.jsonl": "account b" });
    const original = fsops.link;
    let calls = 0;
    fsops.link = (src, dst) => {
      original(src, dst);
      if (++calls === 1) {
        // Another process takes the lock over and finishes the merge meanwhile.
        stealLock();
        for (const [rel, text] of Object.entries({ "p/one.jsonl": "1", "p/two.jsonl": "2", "q/three.jsonl": "3" })) {
          const to = path.join(h.S, "projects", rel);
          fs.mkdirSync(path.dirname(to), { recursive: true });
          if (!fs.existsSync(to)) fs.writeFileSync(to, text);
        }
        fs.renameSync(path.join(A, "projects"), path.join(h.root, "other-process-aside"));
        fs.symlinkSync(path.join(h.S, "projects"), path.join(A, "projects"));
      }
    };
    let res;
    try {
      res = h.repair("acme");
    } finally {
      fsops.link = original;
      fs.rmSync(path.join(h.paths.locks, "store"), { recursive: true, force: true });
    }
    assert.ok(res.problems.some((p) => /another xclaude took over the repair lock/.test(p.message)));
    assert.deepEqual(contents(path.join(h.S, "projects")).sort(), ["1", "2", "3", "account b"]);
    assert.equal(linkTarget(path.join(A, "projects")), path.join(h.S, "projects"));
    assert.deepEqual(leftovers(), []);
  });

  it("stops while emptying the aside, and the next run finishes it", () => {
    writeTree(path.join(A, "skills"), { "a.md": "a", "b.md": "b", "c.md": "c" });
    const original = fs.unlinkSync;
    let stolen = false;
    fs.unlinkSync = ((p: fs.PathLike) => {
      original(p);
      if (!stolen && String(p).includes(".xclaude-merge-skills-")) {
        stolen = true;
        stealLock();
      }
    }) as typeof fs.unlinkSync;
    let res;
    try {
      res = h.repair("acme");
    } finally {
      fs.unlinkSync = original;
    }
    assert.ok(stolen);
    assert.ok(res.problems.some((p) => /took over/.test(p.message)));
    fs.rmSync(path.join(h.paths.locks, "store"), { recursive: true, force: true }); // the other process is done
    assert.equal(h.repair("acme").clean, true);
    assert.deepEqual(contents(path.join(h.S, "skills")), ["a", "b", "c"]);
    assert.deepEqual(leftovers(), []);
  });
});

describe("running sessions during a merge (review findings)", () => {
  it("links a file created during the first pass, so its later appends aren't split", () => {
    writeTree(path.join(A, "projects"), { "p/old.jsonl": "old\n" });
    const originalLink = fsops.link;
    const originalSymlink = fs.symlinkSync;
    let created = false;
    fsops.link = (src, dst) => {
      originalLink(src, dst);
      if (!created) {
        created = true;
        fs.writeFileSync(path.join(A, "projects", "p", "new.jsonl"), "first\n"); // after p/ was read
      }
    };
    fs.symlinkSync = ((target: string, p: string) => {
      originalSymlink(target, p);
      if (p === path.join(A, "projects")) fs.appendFileSync(path.join(A, "projects", "p", "new.jsonl"), "second\n");
    }) as typeof fs.symlinkSync;
    try {
      assert.deepEqual(h.repair("acme").problems, []);
    } finally {
      fsops.link = originalLink;
      fs.symlinkSync = originalSymlink;
    }
    assert.deepEqual(readTree(path.join(h.S, "projects")), { "p/": "/", "p/new.jsonl": "first\nsecond\n", "p/old.jsonl": "old\n" });
  });

  it("gives the name to a file rewritten just before the swap, keeping the old version", () => {
    writeTree(path.join(A, "plugins"), { "installed.json": "old" });
    const original = fs.renameSync;
    let rewritten = false;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (!rewritten && from === path.join(A, "plugins")) {
        rewritten = true;
        const tmp = path.join(A, "plugins", "installed.json.tmp");
        fs.writeFileSync(tmp, "new");
        original(tmp, path.join(A, "plugins", "installed.json")); // an atomic rewrite by the session
      }
      original(from, to);
    }) as typeof fs.renameSync;
    try {
      assert.deepEqual(h.repair("acme").problems, []);
    } finally {
      fs.renameSync = original;
    }
    const tree = readTree(path.join(h.S, "plugins"));
    assert.equal(tree["installed.json"], "new");
    const old = Object.keys(tree).find((k) => k.startsWith("installed.json.xclaude-conflict-acme-"));
    assert.ok(old, "the old version is kept");
    assert.equal(tree[old!], "old");
    assert.ok(!Object.keys(tree).some((k) => k.includes(".xclaude-tmp-")));
  });
});

describe("symlinks inside a merged directory", () => {
  it("keeps relative links that leave the tree pointing at the same place", () => {
    const dev = path.join(h.root, "dev", "my-skill");
    writeTree(dev, { "SKILL.md": "from dev" });
    fs.mkdirSync(path.join(A, "skills", "inner"), { recursive: true });
    fs.writeFileSync(path.join(A, "skills", "inner", "SKILL.md"), "inner");
    fs.symlinkSync(path.relative(path.join(A, "skills"), dev), path.join(A, "skills", "my-skill"));
    fs.symlinkSync("inner", path.join(A, "skills", "alias"));
    assert.deepEqual(h.repair("acme").problems, []);
    assert.equal(fs.realpathSync(path.join(h.S, "skills", "my-skill")), fs.realpathSync(dev));
    assert.equal(fs.readFileSync(path.join(h.S, "skills", "my-skill", "SKILL.md"), "utf8"), "from dev");
    assert.equal(fs.readlinkSync(path.join(h.S, "skills", "alias")), "inner", "links inside the tree stay relative");
    assert.equal(fs.readFileSync(path.join(h.S, "skills", "alias", "SKILL.md"), "utf8"), "inner");
  });
});

