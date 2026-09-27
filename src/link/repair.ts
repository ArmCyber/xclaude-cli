// Per-entry repair. Runs on every account launch (fast path: a
// few syscalls per table entry and no lock when all is well), in `add`, `rm`
// and `doctor --fix`; never for the main identity.
import fs from "node:fs";
import path from "node:path";
import { errCode, lstatOrNull, readlinkOrNull, siblingName, stamp, statOrNull } from "../core/fsutil.ts";
import { DirLock, HISTORY_LOCK, STORE_LOCK } from "../core/lock.ts";
import { accountDir, mkdirPrivate, type Paths, realpathOrNull, tildify } from "../core/paths.ts";
import { type HistoryMergeContext, mergeHistory, resumeHistoryAside } from "./history.ts";
import { asideName, emptyStats, linkTree, LockLost, type MoveContext, moveTree, newRecord, parseAside, requireRealDir, summarize, undoLinks } from "./merge.ts";
import { applyStub, stubState, type StubState } from "./stub.ts";
import { HISTORY, NEVER_SHARED, OPTIONAL_DIRS, STUB, type ShareTable, isIgnored } from "./table.ts";

export type EntryKind = "dir" | "file";

export type EntryState =
  /** A link to S/E or realpath(S/E), whose target exists. */
  | "ok"
  /** Nothing there yet. */
  | "missing"
  /** A correct link, but the store entry is gone. */
  | "store-missing"
  /** A link pointing anywhere else, including a dangling one. */
  | "link-elsewhere"
  /** A real directory where a directory link belongs: needs a directory merge. */
  | "real-dir"
  /** A regular history.jsonl: needs a history merge. */
  | "real-file"
  /** A file where a directory belongs, or the reverse. */
  | "wrong-type"
  /** The store entry itself has the wrong type or doesn't resolve. */
  | "store-wrong-type"
  /** An optional entry (memory) the store doesn't have: the account keeps its own, if any. */
  | "optional-absent"
  /** A link into the store for an entry that's no longer shared. */
  | "unshare";

export interface EntryInfo {
  name: string;
  kind: EntryKind;
  state: EntryState;
  /** The link target, for links. */
  target?: string;
}

export interface Inspection {
  dir: string;
  exists: boolean;
  entries: EntryInfo[];
  /** .xclaude-* entries left by an interrupted repair. */
  leftovers: string[];
  /** The CLAUDE.md stub. */
  stub: StubState;
  /** Every name in the account dir. */
  names: string[];
}

export interface Problem {
  /** The shared entry, or "" for the account dir itself. */
  entry: string;
  message: string;
}

/** A problem as printed: "acme/skills links to …", or "acme's folder is a symlink…". */
export function problemLine(account: string, p: Problem): string {
  return `${account}${p.entry ? `/${p.entry}` : "'s folder"} ${p.message}`;
}

export interface RepairOptions {
  paths: Paths;
  account: string;
  table: ShareTable;
  /** How long to wait for the store lock: a launch gives up after 2 s, the others wait. */
  lockWaitMs: number;
  /** doctor --fix: replace links that point somewhere else. */
  replaceWrongLinks: boolean;
  /** Receives one line per notable change (printed to stderr by the caller). */
  log: (line: string) => void;
}

export interface RepairResult {
  /** Every shared entry is a correct link and nothing is left over. */
  clean: boolean;
  /** The store lock stayed busy, so nothing was repaired. */
  busy: boolean;
  problems: Problem[];
  /** Every name in the account dir afterwards (for the unknown-entry check). */
  names: string[];
}

/** What a launch waits for the store lock before continuing without repairs. */
export const LAUNCH_LOCK_WAIT_MS = 2_000;

type StoreKind = EntryKind | "missing" | "other";

function storeKind(p: string): StoreKind {
  if (!lstatOrNull(p)) return "missing";
  const st = statOrNull(p);
  if (!st) return "other"; // a dangling link
  return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
}

/** Where the state of one shared entry of account dir A stands. */
export function classifyEntry(A: string, S: string, name: string, kind: EntryKind): EntryInfo {
  const a = path.join(A, name);
  const s = path.join(S, name);
  const lst = lstatOrNull(a);
  const optional = OPTIONAL_DIRS.has(name);
  const sk = storeKind(s);
  const storeOk = sk === "missing" || sk === kind;

  if (!lst) {
    if (optional && sk === "missing") return { name, kind, state: "optional-absent" };
    return { name, kind, state: storeOk ? "missing" : "store-wrong-type" };
  }
  if (lst.isSymbolicLink()) {
    const target = readlinkOrNull(a);
    if (target === null) return { name, kind, state: "missing" }; // it changed under us; the locked pass looks again
    if (target === s || target === realpathOrNull(s)) {
      if (sk === kind) return { name, kind, state: "ok", target };
      if (sk === "missing") return { name, kind, state: optional ? "unshare" : "store-missing", target };
      return { name, kind, state: "store-wrong-type", target };
    }
    return { name, kind, state: "link-elsewhere", target };
  }
  if (kind === "dir" && lst.isDirectory()) {
    if (optional && sk === "missing") return { name, kind, state: "optional-absent" };
    return { name, kind, state: storeOk ? "real-dir" : "store-wrong-type" };
  }
  if (kind === "file" && lst.isFile()) return { name, kind, state: storeOk ? "real-file" : "store-wrong-type" };
  return { name, kind, state: "wrong-type" };
}

/**
 * Reads an account dir and classifies every shared entry. Changes nothing.
 * With detail (doctor), the CLAUDE.md stub is compared even when it's there.
 */
export function inspectAccount(paths: Paths, account: string, table: ShareTable, detail = false): Inspection {
  const A = accountDir(paths, account);
  const S = paths.store;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(A, { withFileTypes: true });
  } catch (e) {
    if (errCode(e) !== "ENOENT") throw e;
    return { dir: A, exists: false, entries: [], leftovers: [], stub: "none", names: [] };
  }

  const entries: EntryInfo[] = table.dirs.map((name) => classifyEntry(A, S, name, "dir"));
  if (table.history) entries.push(classifyEntry(A, S, HISTORY, "file"));

  // Links into the store for entries that are no longer shared. Never-shared
  // entries and the stub are left alone even if someone linked them by hand.
  const shared = new Set(entries.map((e) => e.name));
  for (const d of dirents) {
    const name = d.name;
    if (!d.isSymbolicLink() || shared.has(name) || name === STUB || NEVER_SHARED.includes(name) || isIgnored(name)) continue;
    const target = readlinkOrNull(path.join(A, name));
    const s = path.join(S, name);
    if (target === null || (target !== s && target !== realpathOrNull(s))) continue;
    const kind: EntryKind = name === HISTORY || storeKind(s) === "file" ? "file" : "dir";
    entries.push({ name, kind, state: "unshare", target });
  }

  return {
    dir: A,
    exists: true,
    entries,
    leftovers: dirents.map((d) => d.name).filter((n) => n.startsWith(".xclaude-")),
    stub: stubState(A, S, table.stub, detail),
    names: dirents.map((d) => d.name),
  };
}

function needsWork(insp: Inspection, opts: RepairOptions): boolean {
  if (!insp.exists || insp.leftovers.length > 0 || insp.stub === "create" || insp.stub === "remove") return true;
  return insp.entries.some((e) => {
    switch (e.state) {
      case "missing":
      case "store-missing":
      case "real-dir":
      case "real-file":
      case "unshare":
        return true;
      case "link-elsewhere":
        return opts.replaceWrongLinks;
      default:
        return false;
    }
  });
}

/** Problems that stay after a repair (or that a launch doesn't fix). */
export function describeProblems(insp: Inspection, paths: Paths): Problem[] {
  const S = tildify(paths.store, paths.home);
  const problems: Problem[] = [];
  for (const e of insp.entries) {
    const where = `${S}/${e.name}`;
    let message: string | null = null;
    switch (e.state) {
      case "link-elsewhere":
        message = `links to ${e.target}, not ${where}; \`xclaude doctor --fix\` replaces the link`;
        break;
      case "wrong-type":
        message = `is a ${e.kind === "dir" ? "file" : "directory"} where a ${e.kind === "dir" ? "directory" : "file"} link belongs; move it away, then run \`xclaude doctor --fix\``;
        break;
      case "store-wrong-type":
        message = `${where} isn't a ${e.kind === "dir" ? "directory" : "file"} (or doesn't resolve), so it can't be shared`;
        break;
      case "missing":
      case "store-missing":
      case "real-dir":
      case "real-file":
      case "unshare":
        message = "not repaired yet; run `xclaude doctor --fix`";
        break;
      default:
        break;
    }
    if (message) problems.push({ entry: e.name, message });
  }
  for (const name of insp.leftovers) {
    problems.push({ entry: name, message: "left by an interrupted repair; `xclaude doctor --fix` resumes it" });
  }
  return problems;
}

/** Creates S/E if it's missing: a 0700 directory, or an empty 0600 file for history.jsonl. */
export function ensureStoreEntry(S: string, name: string, kind: EntryKind): void {
  fs.mkdirSync(S, { recursive: true, mode: 0o700 });
  const p = path.join(S, name);
  try {
    if (kind === "dir") fs.mkdirSync(p, { mode: 0o700 });
    else fs.closeSync(fs.openSync(p, "wx", 0o600));
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
  }
}

class Repairer {
  readonly A: string;
  readonly S: string;
  readonly opts: RepairOptions;
  readonly lock: DirLock;
  readonly problems: Problem[] = [];
  /** The store lock was taken over: stop, and leave the rest to the next run. */
  lost = false;

  constructor(opts: RepairOptions, lock: DirLock) {
    this.opts = opts;
    this.lock = lock;
    this.A = accountDir(opts.paths, opts.account);
    this.S = opts.paths.store;
  }

  get label(): string {
    return this.opts.account;
  }

  storePath(name: string): string {
    return `${tildify(this.S, this.opts.paths.home)}/${name}`;
  }

  problem(entry: string, message: string): void {
    this.problems.push({ entry, message });
  }

  run(insp: Inspection): void {
    // Entries first, so a running session gets its links back as soon as possible.
    for (const info of insp.entries) this.guard(info.name, () => this.act(info, 0));
    for (const name of insp.leftovers) this.guard(name, () => this.resumeLeftover(name));
    this.guard(STUB, () => applyStub(this.A, insp.stub));
  }

  /** Runs one step; an unexpected error becomes a problem instead of stopping the launch. */
  guard(entry: string, step: () => void): void {
    if (this.lost || !this.lock.refresh()) {
      this.lost = true;
      this.problem(entry, "skipped: another xclaude took over the repair lock; the next run finishes it");
      return;
    }
    try {
      step();
    } catch (e) {
      if (e instanceof LockLost) {
        this.lost = true;
        this.problem(entry, "stopped: another xclaude took over the repair lock; the next run finishes it");
      } else {
        this.problem(entry, `repair failed: ${(e as Error).message}`);
      }
    }
  }

  act(info: EntryInfo, depth: number): void {
    switch (info.state) {
      case "missing":
        this.createLink(info, depth);
        return;
      case "store-missing":
        ensureStoreEntry(this.S, info.name, info.kind);
        return;
      case "link-elsewhere":
        if (this.opts.replaceWrongLinks) this.replaceLink(info);
        return;
      case "unshare":
        this.unshare(info);
        return;
      case "real-dir":
        this.mergeDir(info);
        return;
      case "real-file":
        this.mergeHistory();
        return;
      default:
        return;
    }
  }

  /** realpath(S/E), created first if missing. Never a path inside an account dir. */
  linkTarget(info: EntryInfo): string {
    ensureStoreEntry(this.S, info.name, info.kind);
    const target = realpathOrNull(path.join(this.S, info.name));
    if (!target) throw new Error(`${this.storePath(info.name)} doesn't resolve`);
    // A store entry that resolves into an account dir would make every account's
    // link point at itself (or at one account's private copy).
    const accounts = realpathOrNull(this.opts.paths.accounts) ?? this.opts.paths.accounts;
    if (target === accounts || target.startsWith(`${accounts}${path.sep}`)) {
      throw new Error(`${this.storePath(info.name)} resolves into ${tildify(target, this.opts.paths.home)}, inside an account dir; make it a real ${info.kind === "dir" ? "directory" : "file"} again`);
    }
    return target;
  }

  createLink(info: EntryInfo, depth: number): void {
    const target = this.linkTarget(info);
    try {
      fs.symlinkSync(target, path.join(this.A, info.name));
    } catch (e) {
      if (errCode(e) !== "EEXIST" || depth > 0) throw e;
      // Something created it in between (a running session, another xclaude):
      // take whatever is there now through the table once more.
      this.act(classifyEntry(this.A, this.S, info.name, info.kind), depth + 1);
    }
  }

  replaceLink(info: EntryInfo): void {
    const target = this.linkTarget(info);
    const a = path.join(this.A, info.name);
    const tmp = siblingName(a, "link");
    fs.symlinkSync(target, tmp);
    fs.renameSync(tmp, a); // replaces the old link atomically
    this.opts.log(`xclaude: ${this.label}/${info.name} pointed to ${info.target}; relinked to ${this.storePath(info.name)}`);
  }

  unshare(info: EntryInfo): void {
    const a = path.join(this.A, info.name);
    if (info.kind === "file") {
      const tmp = siblingName(a, "unshare");
      fs.closeSync(fs.openSync(tmp, "wx", 0o600));
      fs.renameSync(tmp, a); // replaces the link atomically
    } else {
      fs.unlinkSync(a);
      try {
        fs.mkdirSync(a, { mode: 0o700 });
      } catch (e) {
        if (errCode(e) !== "EEXIST") throw e;
      }
    }
    this.opts.log(
      `xclaude: ${this.label}/${info.name} is no longer shared and is now per account; the shared copy stays in ${this.storePath(info.name)}`,
    );
  }

  moveContext(): MoveContext {
    return {
      account: this.label,
      stamp: stamp(),
      refresh: () => {
        if (!this.lock.refresh()) throw new LockLost();
      },
    };
  }

  /**
   * Directory merge, link first: every file gets its store link while
   * the real directory is still in place (passes repeat until nothing new
   * appears), then the directory is swapped for the link, then the aside is
   * emptied. A failure before the swap is undone completely, unless the lock
   * was lost: then another process may already rely on those links.
   */
  mergeDir(info: EntryInfo): void {
    const a = path.join(this.A, info.name);
    const target = this.linkTarget(info);
    const ctx = this.moveContext();
    const stats = emptyStats();
    const rec = newRecord();
    let start: fs.Stats;
    try {
      start = requireRealDir(a);
      for (let pass = 0; pass < 5; pass++) {
        if (linkTree(a, target, ctx, stats, rec) === 0) break;
      }
      // Right before the swap: still ours, and still the same directory.
      ctx.refresh();
      const now = lstatOrNull(a);
      if (!now?.isDirectory() || now.ino !== start.ino || now.dev !== start.dev) {
        this.problem(info.name, "changed while being merged; the next run finishes the job");
        return;
      }
    } catch (e) {
      if (e instanceof LockLost) throw e; // guard() reports it; nothing is undone
      undoLinks(rec);
      this.cannotMerge(info.name, e);
      return;
    }

    // The swap.
    const asides: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const aside = path.join(this.A, asideName(info.name));
      fs.renameSync(a, aside);
      asides.push(aside);
      try {
        fs.symlinkSync(target, a);
        break;
      } catch (e) {
        if (errCode(e) !== "EEXIST") {
          fs.renameSync(asides[0]!, a); // put the directory back and undo the link passes
          if (asides.length === 1) undoLinks(rec);
          throw e;
        }
        // A running session re-created the directory in between: set it aside too.
        const now = classifyEntry(this.A, this.S, info.name, "dir");
        if (now.state === "ok") break;
        if (now.state !== "real-dir" || attempt >= 3) throw new Error(`${info.name} kept changing while being merged`);
      }
    }

    // Empty the asides: anything the link passes missed moves first, then placed entries are unlinked.
    asides.forEach((aside, i) => {
      moveTree(aside, target, ctx, stats, i === 0 ? rec : null);
      fs.rmdirSync(aside);
    });
    const line = summarize(this.label, info.name, this.storePath(info.name), stats);
    if (line) this.opts.log(line);
  }

  cannotMerge(entry: string, e: unknown): void {
    const code = errCode(e);
    if (code === "EXDEV") {
      this.problem(
        entry,
        `can't be merged: ${tildify(this.S, this.opts.paths.home)} and ${tildify(this.A, this.opts.paths.home)} are on different filesystems (see \`xclaude doctor\`)`,
      );
    } else {
      this.problem(
        entry,
        `can't be merged, left as it was: ${(e as Error).message}${code === "EACCES" || code === "EPERM" || code === "EROFS" ? `; fix the permissions, or stop sharing ${entry} with share.remove` : ""}`,
      );
    }
  }

  historyContext(): HistoryMergeContext {
    // Claude Code holds these locks for milliseconds; a crashed holder's lock goes
    // stale after 10 s. A launch doesn't wait that long and retries next time.
    const lockWaitMs = this.opts.lockWaitMs === Infinity ? HISTORY_LOCK.staleMs + 2_000 : LAUNCH_LOCK_WAIT_MS;
    return { A: this.A, S: this.S, lockWaitMs, refreshStoreLock: () => this.lock.refresh() };
  }

  /** History merge. */
  mergeHistory(): void {
    this.linkTarget({ name: HISTORY, kind: "file", state: "real-file" });
    const res = mergeHistory(this.historyContext());
    if (!res.ok) {
      this.problem(HISTORY, `not merged yet (${res.reason}); the next launch retries`);
      return;
    }
    if (res.added) {
      this.opts.log(`xclaude: merged ${this.label}'s prompt history into ${this.storePath(HISTORY)}: ${res.added} entries added`);
    }
  }

  resumeLeftover(name: string): void {
    const p = path.join(this.A, name);
    if (name.startsWith(".xclaude-link-") || name.startsWith(".xclaude-unshare-") || name.startsWith(".xclaude-tmp-")) {
      // A temp link or file from a swap that never happened; the entry itself is
      // repaired from scratch.
      const st = lstatOrNull(p);
      if (st?.isDirectory()) fs.rmdirSync(p);
      else if (st) fs.unlinkSync(p);
      return;
    }
    const entry = parseAside(name);
    if (entry === null) {
      this.problem(name, "left by an interrupted repair; remove it by hand if it's empty");
      return;
    }
    const st = lstatOrNull(p);
    if (!st) return;
    if (st.isSymbolicLink()) {
      fs.unlinkSync(p); // an aside is never a link; never read through one
      return;
    }
    if (entry === HISTORY ? !st.isFile() : !st.isDirectory()) {
      this.problem(name, "left by an interrupted repair, but of an unexpected type; look at it by hand");
      return;
    }
    if (entry === HISTORY) {
      const res = resumeHistoryAside(this.historyContext(), p, this.opts.table.history);
      if (!res.ok) this.problem(name, `interrupted history merge not finished (${res.reason})`);
      else if (res.added) this.opts.log(`xclaude: finished merging ${this.label}'s prompt history: ${res.added} entries added`);
      return;
    }
    if (!this.opts.table.dirs.includes(entry)) {
      // No longer shared: the content goes back into the account's own directory,
      // with the same no-clobber moves.
      const own = path.join(this.A, entry);
      if (!lstatOrNull(own)) fs.mkdirSync(own, { mode: 0o700 });
      const st = fs.lstatSync(own);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        this.problem(name, `left by an interrupted merge of ${entry}; ${entry} isn't a directory, so move the contents back by hand`);
        return;
      }
      moveTree(p, own, this.moveContext(), emptyStats());
      fs.rmdirSync(p);
      return;
    }
    // Interrupted after the swap: the aside's files are mostly in the store already.
    const target = this.linkTarget({ name: entry, kind: "dir", state: "ok" });
    const stats = emptyStats();
    try {
      moveTree(p, target, this.moveContext(), stats);
      fs.rmdirSync(p);
    } catch (e) {
      this.cannotMerge(entry, e);
      return;
    }
    const line = summarize(this.label, entry, this.storePath(entry), stats);
    if (line) this.opts.log(line);
  }
}

/**
 * Why an account dir must be left alone, if it must: a symlink would have every repair
 * work through it (into ~/.claude itself, say, linking each entry to itself), and so
 * would a dir that is the store or holds it.
 */
export function unmanageable(A: string, store: string): string | null {
  if (lstatOrNull(A)?.isSymbolicLink()) return "is a symlink; xclaude only manages real folders there, so it leaves this one alone";
  const realA = realpathOrNull(A);
  const realS = realpathOrNull(store);
  if (realA && realS && (realA === realS || realS.startsWith(`${realA}${path.sep}`))) {
    return "is the shared store or holds it; xclaude leaves it alone";
  }
  return null;
}

/**
 * Brings an account dir in line with the share table. Takes no lock when
 * everything is already correct; otherwise takes the store-wide lock, so two
 * accounts never merge into the same store entry at once.
 */
export function repairAccount(opts: RepairOptions): RepairResult {
  const A = accountDir(opts.paths, opts.account);
  const refusal = unmanageable(A, opts.paths.store);
  if (refusal) return { clean: false, busy: false, problems: [{ entry: "", message: refusal }], names: [] };
  let insp = inspectAccount(opts.paths, opts.account, opts.table);
  if (!needsWork(insp, opts)) {
    const problems = describeProblems(insp, opts.paths);
    return { clean: problems.length === 0, busy: false, problems, names: insp.names };
  }

  const lock = DirLock.acquire(path.join(opts.paths.locks, "store"), STORE_LOCK, { waitMs: opts.lockWaitMs });
  if (!lock) {
    const problems = describeProblems(insp, opts.paths);
    return { clean: false, busy: true, problems, names: insp.names };
  }
  try {
    if (!insp.exists) {
      mkdirPrivate(A);
      opts.log(`xclaude: ${opts.account}'s config dir was missing and has been recreated; log in again with /login`);
    }
    insp = inspectAccount(opts.paths, opts.account, opts.table);
    const repairer = new Repairer(opts, lock);
    repairer.run(insp);
    insp = inspectAccount(opts.paths, opts.account, opts.table);
    const failed = new Set(repairer.problems.map((p) => p.entry));
    const problems = [...repairer.problems, ...describeProblems(insp, opts.paths).filter((p) => !failed.has(p.entry))];
    return { clean: problems.length === 0, busy: false, problems, names: insp.names };
  } finally {
    lock.release();
  }
}
