import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  fsops,
  moveNoClobber,
  readlinkOrNull,
  removeTree,
  sameContent,
  stamp,
  writeFileAtomic,
} from "../../src/core/fsutil.ts";
import { readTree, removeTemp, tempDir, writeTree } from "../helpers/tmp.ts";

let root: string;
beforeEach(() => {
  root = tempDir();
});
afterEach(() => removeTemp(root));

describe("writeFileAtomic", () => {
  it("creates a new file with the given mode and leaves no temp files", () => {
    const file = path.join(root, "config.json");
    writeFileAtomic(file, "{}\n", { mode: 0o600, fsync: true });
    assert.equal(fs.readFileSync(file, "utf8"), "{}\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(root), ["config.json"]);
  });

  it("writes through a symlinked file and keeps the link", () => {
    const target = path.join(root, "dotfiles-config.json");
    fs.writeFileSync(target, "old");
    const link = path.join(root, "config.json");
    fs.symlinkSync(target, link);
    writeFileAtomic(link, "new");
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(target, "utf8"), "new");
  });

  it("keeps the mode of an existing file", () => {
    const file = path.join(root, "rc");
    fs.writeFileSync(file, "old");
    fs.chmodSync(file, 0o644);
    writeFileAtomic(file, "new", { mode: 0o600 });
    assert.equal(fs.readFileSync(file, "utf8"), "new");
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  });
});

describe("removeTree", () => {
  it("removes links but never what they point at", () => {
    const outside = path.join(root, "outside");
    writeTree(outside, { "keep.txt": "precious", "sub/deep.txt": "also" });
    const victim = path.join(root, "victim");
    writeTree(victim, {
      "own.txt": "x",
      "dirlink": { link: outside },
      "filelink": { link: path.join(outside, "keep.txt") },
      "nested/dirlink2": { link: path.join(outside, "sub") },
      "nested/dangling": { link: path.join(root, "nowhere") },
    });
    removeTree(victim);
    assert.equal(fs.existsSync(victim), false);
    assert.deepEqual(readTree(outside), { "keep.txt": "precious", "sub/": "/", "sub/deep.txt": "also" });
  });

  it("removes a top-level link without touching its target", () => {
    const target = path.join(root, "target");
    writeTree(target, { "a.txt": "a" });
    fs.symlinkSync(target, path.join(root, "link"));
    removeTree(path.join(root, "link"));
    assert.equal(fs.existsSync(path.join(root, "link")), false);
    assert.equal(fs.readFileSync(path.join(target, "a.txt"), "utf8"), "a");
  });

  it("removes read-only and unreadable directories", () => {
    const victim = path.join(root, "victim");
    writeTree(victim, { "ro/file.txt": "x", "noread/file.txt": "y" });
    fs.chmodSync(path.join(victim, "ro"), 0o500);
    fs.chmodSync(path.join(victim, "noread"), 0o300);
    removeTree(victim);
    assert.equal(fs.existsSync(victim), false);
  });

  it("ignores a missing path", () => {
    removeTree(path.join(root, "missing"));
  });
});

describe("moveNoClobber", () => {
  it("moves a file and keeps its inode", () => {
    const src = path.join(root, "src.txt");
    fs.writeFileSync(src, "data");
    const ino = fs.statSync(src).ino;
    assert.equal(moveNoClobber(src, path.join(root, "dst.txt"), fs.lstatSync(src)), "moved");
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.statSync(path.join(root, "dst.txt")).ino, ino);
  });

  it("never replaces an existing destination", () => {
    const src = path.join(root, "src.txt");
    const dst = path.join(root, "dst.txt");
    fs.writeFileSync(src, "mine");
    fs.writeFileSync(dst, "theirs");
    assert.equal(moveNoClobber(src, dst, fs.lstatSync(src)), "exists");
    assert.equal(fs.readFileSync(src, "utf8"), "mine");
    assert.equal(fs.readFileSync(dst, "utf8"), "theirs");
  });

  it("recreates a symlink instead of following it", () => {
    const src = path.join(root, "link");
    fs.symlinkSync("../somewhere", src);
    assert.equal(moveNoClobber(src, path.join(root, "moved"), fs.lstatSync(src)), "moved");
    assert.equal(readlinkOrNull(path.join(root, "moved")), "../somewhere");
    assert.equal(fs.existsSync(src), false);
  });

  it("propagates an injected EXDEV and leaves the source in place", () => {
    const src = path.join(root, "src.txt");
    fs.writeFileSync(src, "data");
    const original = fsops.link;
    fsops.link = () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    };
    try {
      assert.throws(() => moveNoClobber(src, path.join(root, "dst.txt"), fs.lstatSync(src)), { code: "EXDEV" });
    } finally {
      fsops.link = original;
    }
    assert.equal(fs.readFileSync(src, "utf8"), "data");
  });
});

describe("sameContent", () => {
  it("compares bytes", () => {
    const big = Buffer.alloc(200_000, 7);
    fs.writeFileSync(path.join(root, "a"), big);
    fs.writeFileSync(path.join(root, "b"), big);
    const other = Buffer.from(big);
    other[150_000] = 8;
    fs.writeFileSync(path.join(root, "c"), other);
    fs.writeFileSync(path.join(root, "d"), "short");
    assert.equal(sameContent(path.join(root, "a"), path.join(root, "b")), true);
    assert.equal(sameContent(path.join(root, "a"), path.join(root, "c")), false);
    assert.equal(sameContent(path.join(root, "a"), path.join(root, "d")), false);
  });
});

describe("stamp", () => {
  it("is a compact UTC timestamp", () => {
    assert.equal(stamp(new Date("2026-09-26T14:03:12.345Z")), "20260926T140312Z");
  });
});
