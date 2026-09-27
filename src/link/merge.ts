// Directory merge: used when a real directory sits where a link
// belongs. It runs in two passes around the swap:
//
// 1. Link pass, while A/E is still in place: every file of A/E gets a hard
//    link in the store (directories are made, symlinks recreated). Nothing is
//    moved or replaced; a clash with different content gets a conflict name.
//    The pass repeats until it finds nothing new, so files a running session
//    just created are linked too. If anything fails while the lock is held,
//    whatever the passes created is removed again and A/E is left as it was.
// 2. The swap: A/E is renamed aside and the link takes its place.
// 3. Unlink pass: the aside's entries are unlinked where the store holds the
//    same inode; anything created between the passes is moved first, with
//    no-clobber semantics (link + unlink, never rename).
//
// A running session that appends to a transcript by path writes to the same
// inode before and after the swap, so a conversation isn't split. Nothing is
// ever read through a symlink: an aside must be a real directory.
import fs from "node:fs";
import path from "node:path";
import { errCode, fsops, lstatOrNull, moveNoClobber, sameContent, stamp } from "../core/fsutil.ts";

let counter = 0;

/** A unique aside name for entry E: .xclaude-merge-<E>-<timestamp>-<pid>-<n>. */
export function asideName(entry: string): string {
  return `.xclaude-merge-${entry}-${stamp()}-${process.pid}-${counter++}`;
}

/** The entry an aside name belongs to, or null if it isn't one. */
export function parseAside(name: string): string | null {
  const m = /^\.xclaude-merge-(.+)-\d{8}T\d{6}Z-\d+-\d+$/.exec(name);
  return m ? m[1]! : null;
}

/** The store lock was taken over by another process: stop at once, undo nothing. */
export class LockLost extends Error {
  constructor() {
    super("another xclaude took over the repair lock");
  }
}

export interface MergeStats {
  moved: number;
  /** Identical copies dropped. */
  dropped: number;
  /** Paths of conflict copies, relative to the destination. */
  conflicts: string[];
}

export interface MoveContext {
  account: string;
  /** Timestamp used in conflict names. */
  stamp: string;
  /** Called often: keeps the store lock fresh, and throws LockLost once it isn't ours. */
  refresh: () => void;
}

export function emptyStats(): MergeStats {
  return { moved: 0, dropped: 0, conflicts: [] };
}

interface Placed {
  /** Where the entry lives in the store now. */
  target: string;
  /** The store already had identical content under another inode. */
  identical?: boolean;
}

interface Created {
  path: string;
  kind: "dir" | "file" | "symlink";
  ino?: number;
  dev?: number;
  link?: string;
}

/** What link passes did: where each entry went, and what they created (for undo). */
export interface LinkRecord {
  placed: Map<string, Placed>;
  created: Created[];
  /** created, by path. */
  byPath: Map<string, Created>;
}

export function newRecord(): LinkRecord {
  return { placed: new Map(), created: [], byPath: new Map() };
}

function remember(rec: LinkRecord, c: Created): void {
  rec.created.push(c);
  rec.byPath.set(c.path, c);
}

/** Fails unless dir is a real directory: an aside or a merge source is never read through a link. */
export function requireRealDir(dir: string): fs.Stats {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} isn't a real directory; it won't be read through`);
  return st;
}

/**
 * The target to recreate a symlink with. A relative link that resolves outside
 * the tree being merged would point elsewhere from its new place, so it's made
 * absolute; one that stays inside the tree keeps its text.
 */
function linkText(src: string, root: string): string {
  const text = fs.readlinkSync(src);
  if (path.isAbsolute(text)) return text;
  const resolved = path.resolve(path.dirname(src), text);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? text : resolved;
}

function identicalEntry(src: string, srcStat: fs.Stats, dst: string, root: string): boolean {
  const dstStat = lstatOrNull(dst);
  if (!dstStat) return false;
  if (srcStat.isSymbolicLink()) {
    if (!dstStat.isSymbolicLink()) return false;
    const there = fs.readlinkSync(dst);
    return there === linkText(src, root) || there === fs.readlinkSync(src);
  }
  return srcStat.isFile() && dstStat.isFile() && sameContent(src, dst);
}

function sameInode(a: fs.Stats, b: fs.Stats | null): boolean {
  return b !== null && a.ino === b.ino && a.dev === b.dev;
}

/** Whether an entry's placement from an earlier pass still holds. */
function stillPlaced(p: Placed, src: string, st: fs.Stats, root: string): boolean {
  if (p.identical || st.isSymbolicLink()) return identicalEntry(src, st, p.target, root);
  return sameInode(st, lstatOrNull(p.target));
}

/** A free name for a conflict copy: <name>.xclaude-conflict-<account>-<timestamp>[-n]. */
function conflictName(dir: string, name: string, ctx: MoveContext): string {
  const base = `${name}.xclaude-conflict-${ctx.account}-${ctx.stamp}`;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!lstatOrNull(path.join(dir, candidate))) return candidate;
  }
}

const join = (rel: string, name: string) => (rel ? `${rel}/${name}` : name);

/**
 * One link pass: makes every entry of src reachable under dst without moving or
 * replacing anything, skipping what an earlier pass already placed. Returns how
 * many entries it placed for the first time.
 */
export function linkTree(src: string, dst: string, ctx: MoveContext, stats: MergeStats, rec: LinkRecord, root = src, rel = ""): number {
  let fresh = 0;
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    ctx.refresh();
    const s = path.join(src, d.name);
    const t = path.join(dst, d.name);
    const relName = join(rel, d.name);
    const st = fs.lstatSync(s);
    const prior = rec.placed.get(relName);

    if (st.isDirectory()) {
      let target = t;
      if (prior && lstatOrNull(prior.target)?.isDirectory()) {
        target = prior.target;
      } else {
        try {
          fs.mkdirSync(t, { mode: (st.mode & 0o7777) | 0o700 });
          remember(rec, { path: t, kind: "dir" });
        } catch (e) {
          if (errCode(e) !== "EEXIST") throw e;
          if (!fs.lstatSync(t).isDirectory()) {
            // A file or link already has the name: the whole directory gets a conflict name.
            const name = conflictName(dst, d.name, ctx);
            target = path.join(dst, name);
            fs.mkdirSync(target, { mode: (st.mode & 0o7777) | 0o700 });
            remember(rec, { path: target, kind: "dir" });
            stats.conflicts.push(join(rel, name));
          }
        }
        rec.placed.set(relName, { target });
        fresh++;
      }
      fresh += linkTree(s, target, ctx, stats, rec, root, relName);
      continue;
    }

    if (prior && stillPlaced(prior, s, st, root)) continue;
    const place = (to: string): void => {
      if (st.isSymbolicLink()) {
        const link = linkText(s, root);
        fs.symlinkSync(link, to);
        remember(rec, { path: to, kind: "symlink", link });
      } else {
        fsops.link(s, to);
        remember(rec, { path: to, kind: "file", ino: st.ino, dev: st.dev });
      }
    };
    fresh++;
    try {
      place(t);
      rec.placed.set(relName, { target: t });
      stats.moved++;
      continue;
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
    }
    if (!st.isSymbolicLink() && sameInode(st, lstatOrNull(t))) {
      rec.placed.set(relName, { target: t }); // linked by an earlier, interrupted run
      continue;
    }
    if (identicalEntry(s, st, t, root)) {
      rec.placed.set(relName, { target: t, identical: true });
      stats.dropped++;
      continue;
    }
    const name = conflictName(dst, d.name, ctx);
    place(path.join(dst, name));
    rec.placed.set(relName, { target: path.join(dst, name) });
    stats.moved++;
    stats.conflicts.push(join(rel, name));
  }
  return fresh;
}

/** Removes what failed link passes created, newest first, and only what's still ours. */
export function undoLinks(rec: LinkRecord): void {
  for (const c of [...rec.created].reverse()) {
    const st = lstatOrNull(c.path);
    if (!st) continue;
    try {
      if (c.kind === "dir" && st.isDirectory()) fs.rmdirSync(c.path); // fails if someone put something there
      else if (c.kind === "symlink" && st.isSymbolicLink() && fs.readlinkSync(c.path) === c.link) fs.unlinkSync(c.path);
      else if (c.kind === "file" && st.ino === c.ino && st.dev === c.dev) fs.unlinkSync(c.path);
    } catch {
      // leave it: it isn't empty, or it isn't ours anymore
    }
  }
}

/** Lists a directory we're emptying, making it readable and writable first if needed. */
function openForEmptying(dir: string): fs.Dirent[] {
  const st = requireRealDir(dir);
  if ((st.mode & 0o700) !== 0o700) fs.chmodSync(dir, (st.mode & 0o7777) | 0o700);
  return fs.readdirSync(dir, { withFileTypes: true });
}

/**
 * The account rewrote a file (a new inode) after the link pass, while the store
 * name still holds the older inode that pass created: the newer version takes
 * the name, and the older one is kept as a conflict copy. Nothing is lost, and
 * the account doesn't go back to reading its old file.
 */
function takeOver(src: string, placed: Placed, rec: LinkRecord, dst: string, ctx: MoveContext, stats: MergeStats, rel: string): boolean {
  const ours = rec.byPath.get(placed.target);
  const there = lstatOrNull(placed.target);
  if (!ours || ours.kind !== "file" || !there || there.ino !== ours.ino || there.dev !== ours.dev) return false;
  const base = path.basename(placed.target);
  const old = conflictName(dst, base, ctx);
  fsops.link(placed.target, path.join(dst, old)); // keep the older version
  const tmp = path.join(dst, `.xclaude-tmp-${base}-${process.pid}-${counter++}`);
  fsops.link(src, tmp);
  fs.renameSync(tmp, placed.target); // replaces only the name this merge created; the old inode lives on
  fs.unlinkSync(src);
  stats.conflicts.push(join(rel, old));
  return true;
}

/**
 * Pass 3 (and the resume of an interrupted merge): empties src, a real
 * directory, into dst. Entries not placed by the link passes are moved first,
 * without ever replacing anything:
 * - a directory becomes a mkdir of the same name (an existing one is fine) and is moved recursively
 * - a file is linked into place, then unlinked; a symlink is recreated, then removed
 * - on a clash, an identical copy is dropped and a different one is kept under a conflict name
 * Entries the link passes placed are then just unlinked. Links are never followed.
 */
export function moveTree(src: string, dst: string, ctx: MoveContext, stats: MergeStats, rec: LinkRecord | null = null, root = src, rel = ""): void {
  const entries = openForEmptying(src);
  const isPlaced = (name: string) => Boolean(rec?.placed.has(join(rel, name)));
  entries.sort((a, b) => Number(isPlaced(a.name)) - Number(isPlaced(b.name)));
  for (const d of entries) {
    ctx.refresh();
    const s = path.join(src, d.name);
    const st = fs.lstatSync(s);
    const relName = join(rel, d.name);
    const placed = rec?.placed.get(relName);

    if (st.isDirectory()) {
      let target = path.join(dst, d.name);
      if (placed && lstatOrNull(placed.target)?.isDirectory()) {
        target = placed.target;
      } else {
        try {
          fs.mkdirSync(target, { mode: (st.mode & 0o7777) | 0o700 });
        } catch (e) {
          if (errCode(e) !== "EEXIST") throw e;
          if (!fs.lstatSync(target).isDirectory()) {
            const name = conflictName(dst, d.name, ctx);
            target = path.join(dst, name);
            fs.mkdirSync(target, { mode: (st.mode & 0o7777) | 0o700 });
            stats.conflicts.push(join(rel, name));
          }
        }
      }
      moveTree(s, target, ctx, stats, rec, root, relName);
      fs.rmdirSync(s);
      continue;
    }

    if (placed) {
      if (stillPlaced(placed, s, st, root)) {
        fs.unlinkSync(s); // the store has it already
        continue;
      }
      if (st.isFile() && !placed.identical && rec && takeOver(s, placed, rec, dst, ctx, stats, rel)) {
        stats.moved++;
        continue;
      }
    }
    if (st.isSymbolicLink()) {
      const link = linkText(s, root);
      const to = path.join(dst, d.name);
      try {
        fs.symlinkSync(link, to);
        fs.unlinkSync(s);
        stats.moved++;
        continue;
      } catch (e) {
        if (errCode(e) !== "EEXIST") throw e;
      }
    } else if (moveNoClobber(s, path.join(dst, d.name), st) === "moved") {
      stats.moved++;
      continue;
    }
    if (identicalEntry(s, st, path.join(dst, d.name), root)) {
      fs.unlinkSync(s);
      stats.dropped++;
      continue;
    }
    const name = conflictName(dst, d.name, ctx);
    if (st.isSymbolicLink()) {
      fs.symlinkSync(linkText(s, root), path.join(dst, name));
      fs.unlinkSync(s);
    } else if (moveNoClobber(s, path.join(dst, name), st) !== "moved") {
      throw new Error(`can't place ${relName}: ${name} is taken`);
    }
    stats.moved++;
    stats.conflicts.push(join(rel, name));
  }
}

/** One line summarizing a merge, or null when there was nothing to say. */
export function summarize(account: string, entry: string, storeLabel: string, stats: MergeStats): string | null {
  if (stats.moved + stats.dropped === 0 && stats.conflicts.length === 0) return null;
  const parts = [`${stats.moved} moved`];
  if (stats.dropped) parts.push(`${stats.dropped} identical dropped`);
  let line = `xclaude: merged ${account}/${entry} into ${storeLabel}: ${parts.join(", ")}`;
  if (stats.conflicts.length) {
    const shown = stats.conflicts.slice(0, 3).join(", ");
    const more = stats.conflicts.length > 3 ? ` and ${stats.conflicts.length - 3} more` : "";
    line += `; ${stats.conflicts.length} conflict${stats.conflicts.length > 1 ? "s" : ""} kept as ${shown}${more}`;
  }
  return line;
}
