import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DirLock, HISTORY_LOCK, STORE_LOCK } from "../../src/core/lock.ts";
import { removeTemp, tempDir } from "../helpers/tmp.ts";

let root: string;
beforeEach(() => {
  root = tempDir();
});
afterEach(() => removeTemp(root));

describe("DirLock", () => {
  it("is exclusive and released by its holder", () => {
    const p = path.join(root, "locks", "store");
    const a = DirLock.acquire(p, STORE_LOCK, { waitMs: 0 });
    assert.ok(a, "first acquire succeeds, creating the parent dir");
    assert.equal(DirLock.acquire(p, STORE_LOCK, { waitMs: 100, pollMs: 10 }), null);
    a.release();
    assert.equal(fs.existsSync(p), false);
    const b = DirLock.acquire(p, STORE_LOCK, { waitMs: 0 });
    assert.ok(b);
    b.release();
  });

  it("calls onWait while waiting", () => {
    const p = path.join(root, "busy.lock");
    const holder = DirLock.acquire(p, HISTORY_LOCK, { waitMs: 0 })!;
    let waits = 0;
    assert.equal(DirLock.acquire(p, HISTORY_LOCK, { waitMs: 400, pollMs: 10, onWait: () => waits++ }), null);
    assert.ok(waits >= 2);
    holder.release();
  });

  it("takes over a stale lock", () => {
    const p = path.join(root, "history.jsonl.lock");
    fs.mkdirSync(p);
    const old = new Date(Date.now() - HISTORY_LOCK.staleMs - 5_000);
    fs.utimesSync(p, old, old);
    const lock = DirLock.acquire(p, HISTORY_LOCK, { waitMs: 0 });
    assert.ok(lock);
    assert.ok(lock.held());
    lock.release();
  });

  it("doesn't take over a fresh lock held by someone else", () => {
    const p = path.join(root, "history.jsonl.lock");
    fs.mkdirSync(p);
    assert.equal(DirLock.acquire(p, HISTORY_LOCK, { waitMs: 50, pollMs: 10 }), null);
  });

  it("refreshes the mtime", () => {
    const p = path.join(root, "store");
    const lock = DirLock.acquire(p, STORE_LOCK, { waitMs: 0 })!;
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(p, old, old); // looks old, and no longer carries our mtime
    assert.equal(lock.held(), false);
    assert.equal(lock.refresh(true), false, "a lock that isn't ours is never refreshed");
    lock.release();
    assert.equal(fs.existsSync(p), true, "release leaves someone else's lock alone");
  });

  it("notices a lost lock and never removes the new holder's", () => {
    const p = path.join(root, "store");
    const lock = DirLock.acquire(p, STORE_LOCK, { waitMs: 0 })!;
    assert.ok(lock.refresh(true));
    // Someone judged it stale and took it over; their mtime differs from ours.
    fs.rmdirSync(p);
    fs.mkdirSync(p);
    const theirs = new Date(Date.now() + 2_000);
    fs.utimesSync(p, theirs, theirs);
    assert.equal(lock.held(), false);
    lock.release();
    assert.equal(fs.existsSync(p), true);
  });
});
