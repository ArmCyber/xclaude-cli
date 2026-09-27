// mkdir-based locks with a stale time and a refreshed mtime. The same scheme as
// proper-lockfile, so the history lock is compatible with Claude Code's own
//: a lock is a directory, and one whose mtime is older than the stale
// time is taken over.
import fs from "node:fs";
import path from "node:path";
import { errCode, removeTree, statOrNull } from "./fsutil.ts";
import { sleepSync } from "./sleep.ts";

export interface LockTiming {
  /** Others take the lock over once its mtime is this old. */
  staleMs: number;
  /** The holder refreshes the mtime at least this often. */
  refreshMs: number;
}

/** ~/.xclaude/locks/store: refreshed at least every 10 s, stale after 30 s. */
export const STORE_LOCK: LockTiming = { staleMs: 30_000, refreshMs: 5_000 };

/** <history.jsonl>.lock: Claude Code's lock goes stale after 10 s, so refresh well within 5 s. */
export const HISTORY_LOCK: LockTiming = { staleMs: 10_000, refreshMs: 2_500 };

export interface AcquireOptions {
  /** How long to wait for a busy lock; Infinity waits forever. */
  waitMs: number;
  pollMs?: number;
  /** Called between polls, e.g. to refresh other locks the caller holds. */
  onWait?: () => void;
}

export class DirLock {
  readonly path: string;
  readonly timing: LockTiming;
  private mtimeMs = 0;
  private lastRefresh = 0;
  private released = false;

  private constructor(lockPath: string, timing: LockTiming) {
    this.path = lockPath;
    this.timing = timing;
    this.stampNow();
  }

  /** Takes the lock, or returns null if it stayed busy for waitMs. */
  static acquire(lockPath: string, timing: LockTiming, opts: AcquireOptions): DirLock | null {
    const deadline = Date.now() + opts.waitMs;
    for (;;) {
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        return new DirLock(lockPath, timing);
      } catch (e) {
        if (errCode(e) === "ENOENT") {
          fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
          continue;
        }
        if (errCode(e) !== "EEXIST") throw e;
      }
      const st = statOrNull(lockPath);
      if (st && Date.now() - st.mtimeMs > timing.staleMs) {
        takeOverStale(lockPath);
        continue;
      }
      if (Date.now() >= deadline) return null;
      opts.onWait?.();
      sleepSync(opts.pollMs ?? 50);
    }
  }

  /** True while the lock dir exists with the mtime this holder last set. */
  held(): boolean {
    if (this.released) return false;
    const st = statOrNull(this.path);
    return st !== null && st.mtimeMs === this.mtimeMs;
  }

  /**
   * Refreshes the mtime if refreshMs has passed (or always, with force).
   * Returns false, without touching anything, when the lock is no longer ours.
   */
  refresh(force = false): boolean {
    if (!this.held()) return false;
    if (force || Date.now() - this.lastRefresh >= this.timing.refreshMs) this.stampNow();
    return true;
  }

  /** Removes the lock dir, but only while it's still ours. */
  release(): void {
    if (this.held()) {
      try {
        fs.rmdirSync(this.path);
      } catch (e) {
        if (errCode(e) !== "ENOENT") throw e;
      }
    }
    this.released = true;
  }

  private stampNow(): void {
    const now = new Date();
    fs.utimesSync(this.path, now, now);
    // Keep what the filesystem stored, whatever its timestamp precision.
    this.mtimeMs = fs.statSync(this.path).mtimeMs;
    this.lastRefresh = Date.now();
  }
}

function takeOverStale(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch (e) {
    if (errCode(e) === "ENOENT") return;
    if (errCode(e) === "ENOTEMPTY" || errCode(e) === "EEXIST") removeTree(lockPath);
    else throw e;
  }
}
