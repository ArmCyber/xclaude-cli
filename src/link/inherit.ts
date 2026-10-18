// Settings from ~/.claude. An account's settings.json is its own (plugins on or
// off, a statusline, a model of its own), but the rules, hooks, auto mode and the
// rest of ~/.claude/settings.json should hold under every login. So each launch
// merges what changed in ~/.claude/settings.json since the last merge into the
// account's file. It's a three-way merge: the base, ~/.xclaude/inherit/<name>.json,
// is ~/.claude's settings as last merged, and it tells a change made in ~/.claude
// from one the account made. The account's own additions, edits and deletions
// stay, and a rule deleted from ~/.claude goes from the accounts too.
import fs from "node:fs";
import path from "node:path";
import { type FileStamp, lstatOrNull, readFileOrNull, removeTree, stampOf, writeFileAtomic, writeIfUnchanged } from "../core/fsutil.ts";
import { DirLock, STORE_LOCK } from "../core/lock.ts";
import { accountDir, mkdirPrivate, type Paths } from "../core/paths.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * Settings that stay per account: a login's own environment and credential
 * helpers, a forced login method or organization, and enabledPlugins, which
 * plugins.ts manages.
 */
export const PER_ACCOUNT_KEYS: readonly string[] = [
  "env",
  "enabledPlugins",
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "forceLoginMethod",
  "forceLoginOrgUUID",
];

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON with sorted keys, so objects that differ only in key order compare equal. */
function canon(v: Json | undefined): string {
  if (v === undefined) return "~";
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function same(a: Json | undefined, b: Json | undefined): boolean {
  return canon(a) === canon(b);
}

function each(values: Array<Json | undefined>, test: (v: Json) => boolean): boolean {
  return values.every((v) => v === undefined || test(v));
}

/**
 * Merges one value: base is ~/.claude's at the last merge, main is ~/.claude's now,
 * account is the account's now; undefined means absent. `kept` collects the paths
 * where the account's own change won over a change in ~/.claude.
 */
export function merge3(base: Json | undefined, main: Json | undefined, account: Json | undefined, at: string, kept: string[]): Json | undefined {
  if (same(main, base)) return account; // ~/.claude didn't change it: the account's value stands, a deletion too
  if (same(account, base)) return main; // the account didn't: ~/.claude's value, a deletion too
  if (same(account, main)) return account;
  const values = [base, main, account];
  if (each(values, Array.isArray)) {
    // Lists (permission rules, hook groups, autoMode entries) merge as sets.
    const was = new Set(((base ?? []) as Json[]).map(canon));
    const now = new Set(((main ?? []) as Json[]).map(canon));
    const out = ((account ?? []) as Json[]).filter((x) => now.has(canon(x)) || !was.has(canon(x)));
    const have = new Set(out.map(canon));
    for (const x of (main ?? []) as Json[]) if (!was.has(canon(x)) && !have.has(canon(x))) out.push(x);
    return out.length || (main !== undefined && account !== undefined) ? out : undefined;
  }
  if (each(values, isObject)) {
    const b = (base ?? {}) as JsonObject;
    const m = (main ?? {}) as JsonObject;
    const a = (account ?? {}) as JsonObject;
    const out: JsonObject = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(m), ...Object.keys(b)])) {
      const v = merge3(b[k], m[k], a[k], at ? `${at}.${k}` : k, kept);
      if (v !== undefined) out[k] = v;
    }
    return Object.keys(out).length || (main !== undefined && account !== undefined) ? out : undefined;
  }
  kept.push(at); // both changed a single value, differently: the account's choice wins
  return account;
}

/** ~/.claude's settings without the per-account keys. */
export function inheritable(settings: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !PER_ACCOUNT_KEYS.includes(k)));
}

export interface Merged {
  next: JsonObject;
  /** The base to keep for the next merge. */
  base: JsonObject;
  kept: string[];
}

/**
 * The account's next settings. Keys in neither ~/.claude nor the base (the
 * account's own) are never touched. A first merge has no base, so it can't tell
 * who changed what: lists are joined, objects merged, and where the two hold
 * different single values the account's stays. Nothing is removed without a base.
 */
export function mergeSettings(base: JsonObject | undefined, main: JsonObject, account: JsonObject): Merged {
  const picked = inheritable(main);
  const kept: string[] = [];
  const next: JsonObject = { ...account };
  for (const k of new Set([...Object.keys(picked), ...Object.keys(base ?? {})])) {
    if (PER_ACCOUNT_KEYS.includes(k)) continue;
    const v = merge3(base?.[k], picked[k], account[k], k, kept);
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return { next, base: picked, kept };
}

export function basePath(paths: Paths, account: string): string {
  return path.join(paths.inherit, `${account}.json`);
}

/** The saved base; undefined when there's none or it can't be read, which merges as a first merge. */
function readBase(paths: Paths, account: string): JsonObject | undefined {
  try {
    const v: unknown = JSON.parse(readFileOrNull(basePath(paths, account)) ?? "null");
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** ~/.claude/settings.json, followed if it's a link (dotfiles); missing is {}. */
export function mainSettings(paths: Paths): { settings: JsonObject } | { problem: string } {
  let text: string | null;
  try {
    text = readFileOrNull(path.join(paths.store, "settings.json"));
  } catch (e) {
    return { problem: `~/.claude/settings.json can't be read (${(e as Error).message})` };
  }
  if (text === null) return { settings: {} };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { problem: "~/.claude/settings.json isn't valid JSON" };
  }
  return isObject(v) ? { settings: v } : { problem: "~/.claude/settings.json isn't a JSON object" };
}

export interface InheritPlan {
  /** The account's settings.json. */
  file: string;
  /** The settings after the merge. */
  next: JsonObject;
  /** The new settings.json, or null when it stays as it is. */
  text: string | null;
  /** Top-level settings whose value changes in the account. */
  changed: string[];
  /** Where the account's own value stays over a change in ~/.claude. */
  kept: string[];
  base: JsonObject;
  /** Whether the saved base needs writing. */
  baseChanged: boolean;
  /** No base yet: the account's first merge. */
  first: boolean;
  /** The file as read (null: missing); a different one at write time means Claude Code wrote it. */
  seen: FileStamp | null;
}

/**
 * Works out the account's next settings.json, without writing anything. Null when
 * there's nothing it can do: no account folder, or settings that are a link,
 * unparsable or not an object (Claude Code reports a broken settings file itself).
 * With `main`, merges that instead of ~/.claude/settings.json.
 */
export function planInherit(paths: Paths, account: string, main?: JsonObject): InheritPlan | { problem: string } | null {
  const dir = accountDir(paths, account);
  if (!lstatOrNull(dir)?.isDirectory()) return null;
  let theirs = main;
  if (!theirs) {
    const read = mainSettings(paths);
    if ("problem" in read) return read;
    theirs = read.settings;
  }
  const file = path.join(dir, "settings.json");
  const st = lstatOrNull(file);
  if (st && !st.isFile()) return null;
  const original = st ? fs.readFileSync(file, "utf8") : null;
  let ours: unknown = {};
  if (original !== null) {
    try {
      ours = JSON.parse(original);
    } catch {
      return null;
    }
  }
  if (!isObject(ours)) return null;
  const current = ours;
  // A missing settings.json starts over, whatever the base says.
  const stored = original === null ? undefined : readBase(paths, account);
  const { next, base, kept } = mergeSettings(stored, theirs, current);
  const changed = [...new Set([...Object.keys(current), ...Object.keys(next)])].filter((k) => !same(current[k], next[k]));
  const ending = original === null || original.endsWith("\n") ? "\n" : "";
  return {
    file,
    next,
    text: changed.length ? `${JSON.stringify(next, null, 2)}${ending}` : null,
    changed,
    kept,
    base,
    baseChanged: !same(stored ?? {}, base),
    first: stored === undefined,
    seen: stampOf(st),
  };
}

function saveBase(paths: Paths, account: string, base: JsonObject): void {
  mkdirPrivate(paths.inherit);
  writeFileAtomic(basePath(paths, account), `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
}

/** Deletes the account's base: `rm`, and `--inherit off|reset`. */
export function forgetInherit(paths: Paths, account: string): void {
  removeTree(basePath(paths, account));
}

/** "a, b, c", or the first six "and 3 more". */
function listed(names: string[]): string {
  return names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
}

function logMerge(account: string, plan: InheritPlan, log: (line: string) => void): void {
  if (plan.changed.length) {
    if (plan.first) {
      log(`xclaude: ${account} takes ~/.claude/settings.json now (${listed(plan.changed)}); its own changes stay. Turn that off with: xclaude set ${account} --inherit off`);
    } else log(`xclaude: ${account} took ~/.claude/settings.json's changes to ${listed(plan.changed)}`);
  }
  if (plan.kept.length) log(`xclaude: ${account} keeps its own ${listed(plan.kept)}, which ~/.claude/settings.json sets differently`);
}

export interface InheritResult {
  changed: string[];
  kept: string[];
  /** The store lock stayed busy, or Claude Code wrote the settings meanwhile; the next run retries. */
  deferred: boolean;
}

/**
 * Merges ~/.claude/settings.json into the account's settings.json. Lock-free
 * when ~/.claude has nothing new for it; otherwise plans again under the store
 * lock, writes the settings only if nobody wrote them in between, then the base.
 * Never throws: a failure is logged.
 */
export function inheritSettings(paths: Paths, account: string, opts: { lockWaitMs: number; log: (line: string) => void }): InheritResult {
  const result: InheritResult = { changed: [], kept: [], deferred: false };
  try {
    const first = planInherit(paths, account);
    if (first && "problem" in first) {
      opts.log(`xclaude: ${first.problem}, so ${account} keeps its settings as they are`);
      return result;
    }
    if (!first || (first.text === null && !first.baseChanged)) return result;
    const lock = DirLock.acquire(path.join(paths.locks, "store"), STORE_LOCK, { waitMs: opts.lockWaitMs });
    if (!lock) return { ...result, deferred: true };
    try {
      const plan = planInherit(paths, account);
      if (!plan || "problem" in plan) return result;
      if (plan.text !== null && !writeIfUnchanged(plan.file, plan.text, plan.seen)) return { ...result, deferred: true };
      if (plan.text !== null || plan.baseChanged) saveBase(paths, account, plan.base);
      logMerge(account, plan, opts.log);
      return { changed: plan.changed, kept: plan.kept, deferred: false };
    } finally {
      lock.release();
    }
  } catch (e) {
    opts.log(`xclaude: couldn't merge ~/.claude/settings.json into ${account} (${(e as Error).message})`);
    return result;
  }
}

/**
 * Takes back what the account took from ~/.claude and hasn't changed since (the
 * merge against an empty ~/.claude), then forgets the base. False, with the base
 * kept for another try, when the store lock stayed busy or Claude Code wrote the
 * settings meanwhile.
 */
export function stopInheriting(paths: Paths, account: string, opts: { lockWaitMs: number; log: (line: string) => void }): boolean {
  const lock = DirLock.acquire(path.join(paths.locks, "store"), STORE_LOCK, { waitMs: opts.lockWaitMs });
  if (!lock) return false;
  try {
    const plan = planInherit(paths, account, {});
    if (plan && !("problem" in plan) && plan.text !== null) {
      if (!writeIfUnchanged(plan.file, plan.text, plan.seen)) return false;
      opts.log(`xclaude: took back what ${account} had from ~/.claude/settings.json: ${listed(plan.changed)}`);
    }
    forgetInherit(paths, account);
    return true;
  } finally {
    lock.release();
  }
}

/** Forgets the base and merges again as the first time, so whatever ~/.claude sets comes back. */
export function resetInherit(paths: Paths, account: string, opts: { lockWaitMs: number; log: (line: string) => void }): InheritResult {
  forgetInherit(paths, account);
  return inheritSettings(paths, account, opts);
}

/**
 * For doctor: the settings the next merge would change, and the ones where the
 * account keeps its own value. Null when its settings can't be merged.
 */
export function inheritStatus(paths: Paths, account: string, main: JsonObject): { pending: string[]; own: string[] } | null {
  const plan = planInherit(paths, account, main);
  if (!plan || "problem" in plan) return null;
  const picked = inheritable(main);
  return { pending: plan.changed, own: Object.keys(picked).filter((k) => !same(plan.next[k], picked[k])) };
}
