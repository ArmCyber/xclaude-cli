// Filesystem helpers. Invariant 1: deletion never follows links, and content is
// never moved with rename onto an existing path.
import fs from "node:fs";
import path from "node:path";

/** Operations tests can replace to inject faults, e.g. EXDEV from link. */
export const fsops = {
  link: (src: string, dst: string): void => fs.linkSync(src, dst),
};

export function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return null;
    throw e;
  }
}

export function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR" || errCode(e) === "ELOOP") return null;
    throw e;
  }
}

export function readlinkOrNull(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "EINVAL" || errCode(e) === "ENOTDIR") return null;
    throw e;
  }
}

export function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return null;
    throw e;
  }
}

let counter = 0;

/** A unique .xclaude-<tag>-… name next to target, for temp files and asides. */
export function siblingName(target: string, tag: string): string {
  return path.join(path.dirname(target), `.xclaude-${tag}-${path.basename(target)}-${process.pid}-${Date.now()}-${counter++}`);
}

/**
 * Writes through a temp file in the same directory, then renames it over the
 * target. An existing file keeps its mode; a new one gets `mode`. A symlink is
 * followed, so the link itself is kept.
 */
export function writeFileAtomic(path_: string, data: string | Buffer, opts: { mode?: number; fsync?: boolean } = {}): void {
  // A symlinked file (dotfiles) is written at its target and stays a link.
  let file = path_;
  try {
    file = fs.realpathSync(path_);
  } catch {
    // missing: written as a new file
  }
  const existing = statOrNull(file);
  const mode = existing ? existing.mode & 0o7777 : (opts.mode ?? 0o600);
  const tmp = siblingName(file, "tmp");
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, data);
    if (opts.fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode); // open() applies the umask
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Removes a file, link or directory tree without ever following links: a link is
 * removed itself, and whatever it points at is left alone.
 */
export function removeTree(p: string): void {
  const st = lstatOrNull(p);
  if (!st) return;
  if (!st.isDirectory()) {
    fs.unlinkSync(p);
    return;
  }
  // A directory without read or write permission can't be listed or emptied;
  // make it accessible once and retry.
  const retry = <T>(op: () => T): T => {
    try {
      return op();
    } catch (e) {
      if (errCode(e) !== "EACCES" && errCode(e) !== "EPERM") throw e;
      fs.chmodSync(p, 0o700);
      return op();
    }
  };
  for (const name of retry(() => fs.readdirSync(p))) {
    retry(() => removeTree(path.join(p, name)));
  }
  fs.rmdirSync(p);
}

/**
 * Moves one file or symlink to dst without ever replacing anything: a hard link
 * (or a recreated symlink) plus unlink of the source. Returns "exists" when dst is
 * taken; link fails with EEXIST where rename would silently overwrite, which also
 * catches a same-name file created at the same moment and a case-only clash on a
 * case-insensitive volume. The source keeps its inode, so open descriptors survive.
 */
export function moveNoClobber(src: string, dst: string, srcStat: fs.Stats): "moved" | "exists" {
  try {
    if (srcStat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dst);
    else fsops.link(src, dst);
  } catch (e) {
    if (errCode(e) === "EEXIST") return "exists";
    throw e;
  }
  fs.unlinkSync(src);
  return "moved";
}

/** True when two regular files have the same bytes. */
export function sameContent(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  if (sa.size !== sb.size) return false;
  if (sa.ino === sb.ino && sa.dev === sb.dev) return true;
  const fa = fs.openSync(a, "r");
  const fb = fs.openSync(b, "r");
  try {
    const ba = Buffer.alloc(65536);
    const bb = Buffer.alloc(65536);
    for (;;) {
      const na = fs.readSync(fa, ba, 0, ba.length, null);
      const nb = fs.readSync(fb, bb, 0, bb.length, null);
      if (na !== nb) return false;
      if (na === 0) return true;
      if (!ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
    }
  } finally {
    fs.closeSync(fa);
    fs.closeSync(fb);
  }
}

/** A compact UTC timestamp for aside and conflict names, e.g. 20260926T140312Z. */
export function stamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
