// Directory merge.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fsops } from "../../src/core/fsutil.ts";
import { asideName, parseAside } from "../../src/link/merge.ts";
import { type Home, linkTarget, makeHome } from "../helpers/accounts.ts";
import { readTree, writeTree } from "../helpers/tmp.ts";

let h: Home;
let A: string;
beforeEach(() => {
  h = makeHome();
  A = h.account("acme");
});
afterEach(() => h.cleanup());

/** Every regular file's content under a directory, sorted. */
function contents(dir: string): string[] {
  return Object.entries(readTree(dir))
    .filter(([k, v]) => !k.endsWith("/") && !v.startsWith("-> "))
    .map(([, v]) => v)
    .sort();
}

describe("directory merge", () => {
  it("moves a real directory into the store and links it", () => {
    writeTree(path.join(A, "skills"), {
      "a/SKILL.md": "a",
      "b/SKILL.md": "b",
      "b/deep/x.txt": "x",
      "link": { link: "a/SKILL.md" },
    });
    const ino = fs.statSync(path.join(A, "skills", "a", "SKILL.md")).ino;
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.equal(linkTarget(path.join(A, "skills")), path.join(h.S, "skills"));
    assert.deepEqual(readTree(path.join(h.S, "skills")), {
      "a/": "/",
      "a/SKILL.md": "a",
      "b/": "/",
      "b/SKILL.md": "b",
      "b/deep/": "/",
      "b/deep/x.txt": "x",
      "link": "-> a/SKILL.md",
    });
    assert.equal(fs.statSync(path.join(h.S, "skills", "a", "SKILL.md")).ino, ino, "files keep their inode");
    assert.deepEqual(fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-")), []);
    assert.match(h.logs.join("\n"), /merged acme\/skills into ~\/\.claude\/skills: 4 moved/);
  });

  it("keeps an open file descriptor working", () => {
    writeTree(path.join(A, "projects"), { "p/session.jsonl": "line1\n" });
    const fd = fs.openSync(path.join(A, "projects", "p", "session.jsonl"), "a");
    try {
      h.repair("acme");
      fs.writeSync(fd, "line2\n");
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fs.readFileSync(path.join(h.S, "projects", "p", "session.jsonl"), "utf8"), "line1\nline2\n");
  });

  it("drops identical copies and keeps different ones under conflict names", () => {
    writeTree(path.join(h.S, "skills"), {
      "same.md": "same",
      "diff.md": "store version",
      "samelink": { link: "target" },
      "difflink": { link: "store-target" },
      "was-file": "a file in the store",
      "was-dir/inner.md": "store dir",
    });
    writeTree(path.join(A, "skills"), {
      "same.md": "same",
      "diff.md": "account version",
      "samelink": { link: "target" },
      "difflink": { link: "account-target" },
      "was-file/inner.md": "now a dir",
      "was-dir": "now a file",
      "new.md": "new",
    });
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    const tree = readTree(path.join(h.S, "skills"));
    assert.equal(tree["same.md"], "same");
    assert.equal(tree["diff.md"], "store version");
    assert.equal(tree["new.md"], "new");
    assert.equal(tree.samelink, "-> target");
    assert.equal(tree.difflink, "-> store-target");
    assert.equal(tree["was-file"], "a file in the store");
    assert.equal(tree["was-dir/inner.md"], "store dir");
    const conflicts = Object.keys(tree).filter((k) => k.includes(".xclaude-conflict-acme-"));
    const byBase = (base: string) => conflicts.find((k) => k.startsWith(`${base}.xclaude-conflict-acme-`))!;
    assert.equal(tree[byBase("diff.md")], "account version");
    assert.equal(tree[byBase("difflink")], "-> account-target");
    assert.equal(tree[`${byBase("was-file").replace(/\/$/, "")}/inner.md`], "now a dir");
    assert.equal(tree[byBase("was-dir")], "now a file");
    assert.match(conflicts[0]!, /\.xclaude-conflict-acme-\d{8}T\d{6}Z/);
    assert.match(h.logs.join("\n"), /2 identical dropped; 4 conflicts kept as/);
  });

  it("never loses content on a case-only clash (case-insensitive volumes)", () => {
    writeTree(path.join(h.S, "commands"), { "deploy.md": "store" });
    writeTree(path.join(A, "commands"), { "Deploy.md": "account" });
    h.repair("acme");
    assert.deepEqual(contents(path.join(h.S, "commands")), ["account", "store"]);
  });

  it("merges a directory a running session re-created in between", () => {
    writeTree(path.join(A, "plans"), { "one.md": "1" });
    const original = fs.symlinkSync;
    let raced = false;
    fs.symlinkSync = ((target: string, p: string) => {
      if (!raced && p === path.join(A, "plans")) {
        raced = true;
        writeTree(path.join(A, "plans"), { "two.md": "2" }); // the session was faster
      }
      original(target, p);
    }) as typeof fs.symlinkSync;
    try {
      assert.deepEqual(h.repair("acme").problems, []);
    } finally {
      fs.symlinkSync = original;
    }
    assert.ok(raced);
    assert.equal(linkTarget(path.join(A, "plans")), path.join(h.S, "plans"));
    assert.deepEqual(contents(path.join(h.S, "plans")), ["1", "2"]);
    assert.deepEqual(fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-")), []);
  });

  it("rolls back on EXDEV and explains", () => {
    writeTree(path.join(A, "skills"), { "a.md": "a", "sub/b.md": "b" });
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
    assert.equal(res.clean, false);
    assert.match(res.problems.find((p) => p.entry === "skills")!.message, /different filesystems/);
    const st = fs.lstatSync(path.join(A, "skills"));
    assert.ok(st.isDirectory() && !st.isSymbolicLink(), "the real directory is back");
    assert.deepEqual(readTree(path.join(A, "skills")), { "a.md": "a", "sub/": "/", "sub/b.md": "b" });
    assert.deepEqual(fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-")), []);
  });
});

describe("interrupted merges", () => {
  it("parses aside names", () => {
    for (const e of ["skills", "session-env", "file-history", "history.jsonl"]) assert.equal(parseAside(asideName(e)), e);
    assert.equal(parseAside(".xclaude-merge-skills"), null);
    assert.equal(parseAside("skills"), null);
  });

  it("resumes an aside left after the link was made", () => {
    h.repair("acme");
    writeTree(path.join(A, asideName("skills")), { "left.md": "left behind" });
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.equal(fs.readFileSync(path.join(h.S, "skills", "left.md"), "utf8"), "left behind");
    assert.deepEqual(fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-")), []);
  });

  it("resumes an aside left before the link was made", () => {
    writeTree(path.join(A, asideName("agents")), { "reviewer.md": "r" });
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.equal(linkTarget(path.join(A, "agents")), path.join(h.S, "agents"));
    assert.equal(fs.readFileSync(path.join(h.S, "agents", "reviewer.md"), "utf8"), "r");
  });

  it("gives an entry that's no longer shared its directory back", () => {
    h.config.share.remove = ["skills"];
    writeTree(path.join(A, asideName("skills")), { "mine.md": "m" });
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.equal(fs.readFileSync(path.join(A, "skills", "mine.md"), "utf8"), "m");
  });
});

describe("concurrent merges", () => {
  it("two processes merging into the same entry lose nothing", async () => {
    const runner = fileURLToPath(new URL("../helpers/run-repair.ts", import.meta.url));
    const files: Record<string, string> = {};
    const other: Record<string, string> = {};
    for (let i = 0; i < 300; i++) {
      files[`s${i % 10}/f${i}.md`] = `a-${i}`;
      // Half the names clash: every other one identical, the rest different.
      other[`s${i % 10}/f${i}.md`] = i % 2 ? `a-${i}` : `b-${i}`;
      other[`only-b/g${i}.md`] = `g-${i}`;
    }
    writeTree(path.join(A, "skills"), files);
    const B = h.account("b");
    writeTree(path.join(B, "skills"), other);

    const run = (account: string) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", runner, h.paths.home, account], {
          env: {},
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code, out, err }));
      });
    const results = await Promise.all([run("acme"), run("b")]);
    for (const r of results) {
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(JSON.parse(r.out).problems, []);
    }

    assert.equal(linkTarget(path.join(A, "skills")), path.join(h.S, "skills"));
    assert.equal(linkTarget(path.join(B, "skills")), path.join(h.S, "skills"));
    const all = contents(path.join(h.S, "skills"));
    const expected = [...new Set([...Object.values(files), ...Object.values(other)])].sort();
    assert.deepEqual(all, expected, "every distinct content survives exactly once");
    assert.equal(fs.existsSync(path.join(h.paths.locks, "store")), false);
  });
});
