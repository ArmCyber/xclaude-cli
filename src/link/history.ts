// History merge: used when an account's history.jsonl is a
// regular file. Claude Code appends to it under a proper-lockfile lock on the
// file's resolved path, so this merge takes the same locks: the
// account's, from before the swap until the very end, and the store's around
// the rewrite.
import fs from "node:fs";
import path from "node:path";
import { lstatOrNull, readFileOrNull, siblingName, writeFileAtomic } from "../core/fsutil.ts";
import { DirLock, HISTORY_LOCK } from "../core/lock.ts";
import { realpathOrNull } from "../core/paths.ts";
import { asideName } from "./merge.ts";
import { HISTORY } from "./table.ts";

/** The timestamp of one history line in ms, or null if it has none. */
export function timestampOf(line: string): number | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof entry !== "object" || entry === null) return null;
  const ts = (entry as { timestamp?: unknown }).timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const ms = Date.parse(ts);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Combines two histories: exact duplicates are dropped, entries are ordered by
 * timestamp, and entries without one keep their place after the entry before
 * them in their own file.
 */
export function mergeHistoryLines(store: string[], account: string[]): string[] {
  const seen = new Set<string>();
  const items: Array<{ line: string; key: number; src: number; idx: number }> = [];
  [store, account].forEach((lines, src) => {
    let key = -Infinity;
    lines.forEach((line, idx) => {
      if (line.trim() === "" || seen.has(line)) return;
      seen.add(line);
      key = timestampOf(line) ?? key;
      items.push({ line, key, src, idx });
    });
  });
  items.sort((a, b) => a.key - b.key || a.src - b.src || a.idx - b.idx);
  return items.map((i) => i.line);
}

function readLines(file: string): string[] {
  return (readFileOrNull(file) ?? "").split("\n");
}

export interface HistoryMergeContext {
  /** Account dir. */
  A: string;
  /** The store, ~/.claude. */
  S: string;
  /** How long to wait for each history lock. */
  lockWaitMs: number;
  /** Keeps the store-wide lock fresh while waiting. */
  refreshStoreLock: () => void;
}

/** On success, how many of the account's lines were new to the store. */
export type HistoryMergeResult = { ok: true; added: number } | { ok: false; reason: string };

/** The store's history lock sits at the resolved path, like Claude Code's own. */
function storeLockPath(S: string): string {
  return `${realpathOrNull(path.join(S, HISTORY)) ?? path.join(S, HISTORY)}.lock`;
}

/**
 * Merges an aside file's lines into S/history.jsonl under the store's history
 * lock, while `alsoHeld` (if any) stays fresh. Removes the aside on success.
 */
function mergeAsideIntoStore(ctx: HistoryMergeContext, aside: string, alsoHeld: DirLock | null): HistoryMergeResult {
  const refreshAll = () => {
    ctx.refreshStoreLock();
    alsoHeld?.refresh();
  };
  // While we hold the account's lock its writers wait on it; Claude Code retries
  // for only a few seconds, so don't keep them waiting longer than that.
  const waitMs = alsoHeld ? Math.min(ctx.lockWaitMs, 5_000) : ctx.lockWaitMs;
  const storeLock = DirLock.acquire(storeLockPath(ctx.S), HISTORY_LOCK, { waitMs, onWait: refreshAll });
  if (!storeLock) return { ok: false, reason: "the shared history.jsonl is busy" };
  try {
    const storeFile = realpathOrNull(path.join(ctx.S, HISTORY));
    if (!storeFile) return { ok: false, reason: "~/.claude/history.jsonl doesn't resolve" };
    const storeLines = readLines(storeFile);
    const merged = mergeHistoryLines(storeLines, readLines(aside));
    refreshAll();
    // Abort if either lock was taken over meanwhile: the aside stays for the next repair.
    if (!storeLock.refresh() || (alsoHeld && !alsoHeld.refresh())) return { ok: false, reason: "a history lock was taken over" };
    // Durable before the aside, the account's only other copy, goes away.
    writeFileAtomic(storeFile, merged.length ? `${merged.join("\n")}\n` : "", { mode: 0o600, fsync: true });
    fs.unlinkSync(aside);
    const before = new Set(storeLines);
    return { ok: true, added: merged.filter((line) => !before.has(line)).length };
  } finally {
    storeLock.release();
  }
}

/**
 * The full merge: lock the account's history, keep its content aside through a
 * hard link, swap in the link to the store, merge, and release the account's
 * lock last, so a writer that resolved the old path appends only after the
 * rewrite is done.
 */
export function mergeHistory(ctx: HistoryMergeContext): HistoryMergeResult {
  const file = path.join(ctx.A, HISTORY);
  // 1. The account's lock: no session of this account is mid-append while we hold it.
  const accountLock = DirLock.acquire(`${file}.lock`, HISTORY_LOCK, { waitMs: ctx.lockWaitMs, onWait: ctx.refreshStoreLock });
  if (!accountLock) return { ok: false, reason: `this account's history.jsonl is busy` };
  try {
    const st = lstatOrNull(file);
    if (!st?.isFile()) return { ok: true, added: 0 }; // someone else already swapped it
    const storeFile = realpathOrNull(path.join(ctx.S, HISTORY));
    if (!storeFile) return { ok: false, reason: "~/.claude/history.jsonl doesn't resolve" };
    // 2. Keep the content: a hard link survives the swap.
    const aside = path.join(ctx.A, asideName(HISTORY));
    fs.linkSync(file, aside);
    // 3. Swap in the link atomically; from now on appends go to the store.
    const tmp = siblingName(file, "link");
    fs.symlinkSync(storeFile, tmp);
    fs.renameSync(tmp, file);
    // 4–6. Merge under the store's lock, keeping ours fresh.
    return mergeAsideIntoStore(ctx, aside, accountLock);
  } finally {
    // 7. Last.
    accountLock.release();
  }
}

/**
 * Finishes a merge an earlier run left behind. The aside is a hard link of the
 * account's old history; merging it again is harmless, since duplicates drop.
 */
export function resumeHistoryAside(ctx: HistoryMergeContext, aside: string, shared: boolean): HistoryMergeResult {
  const file = path.join(ctx.A, HISTORY);
  const st = lstatOrNull(file);
  const asideStat = fs.lstatSync(aside);
  if (st?.isFile() && st.ino === asideStat.ino && st.dev === asideStat.dev) {
    // Interrupted before the swap: the account's file still has everything.
    fs.unlinkSync(aside);
    return { ok: true, added: 0 };
  }
  if (!shared) return mergeAsideIntoAccount(ctx, aside);
  return mergeAsideIntoStore(ctx, aside, null);
}

/**
 * History that's no longer shared: an interrupted merge's lines go back into the
 * account's own history.jsonl, under its lock, never by renaming over it.
 */
function mergeAsideIntoAccount(ctx: HistoryMergeContext, aside: string): HistoryMergeResult {
  const file = path.join(ctx.A, HISTORY);
  const lock = DirLock.acquire(`${file}.lock`, HISTORY_LOCK, { waitMs: ctx.lockWaitMs, onWait: ctx.refreshStoreLock });
  if (!lock) return { ok: false, reason: "this account's history.jsonl is busy" };
  try {
    const st = lstatOrNull(file);
    if (st && !st.isFile()) return { ok: false, reason: "this account's history.jsonl isn't a regular file" };
    const own = readLines(file);
    const merged = mergeHistoryLines(own, readLines(aside));
    if (!lock.refresh()) return { ok: false, reason: "a history lock was taken over" };
    writeFileAtomic(file, merged.length ? `${merged.join("\n")}\n` : "", { mode: 0o600, fsync: true });
    fs.unlinkSync(aside);
    const before = new Set(own);
    return { ok: true, added: merged.filter((line) => !before.has(line)).length };
  } finally {
    lock.release();
  }
}
