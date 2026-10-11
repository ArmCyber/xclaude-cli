// Plugins installed under another identity. The plugin registry is shared, but
// which plugins are on is each account's settings.json, and /plugin lists as
// installed only the plugins those settings name (F25): one installed under
// another identity is missing there, so there's nowhere to turn it on. xclaude
// names it there as off. It remembers what it added (state.json) and takes an
// entry back out once the plugin is uninstalled, if it's still off.
import fs from "node:fs";
import path from "node:path";
import { lstatOrNull, readFileOrNull, writeFileAtomic } from "../core/fsutil.ts";
import { DirLock, STORE_LOCK } from "../core/lock.ts";
import { accountDir, type Paths, realpathOrNull } from "../core/paths.ts";
import { loadState, updateState } from "../core/state.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The plugins with a user-scope install record in the store's registry, sorted.
 * Empty when nothing is installed; null when the registry can't be read.
 */
export function userPlugins(paths: Paths): string[] | null {
  const dir = realpathOrNull(path.join(paths.store, "plugins"));
  if (!dir) return null;
  let text: string | null;
  try {
    text = readFileOrNull(path.join(dir, "installed_plugins.json"));
  } catch {
    return null;
  }
  if (text === null) return [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null; // mid-write: the next run sees it
  }
  if (!isRecord(json) || !isRecord(json.plugins)) return null;
  return Object.entries(json.plugins)
    .filter(([, records]) => Array.isArray(records) && records.some((r) => isRecord(r) && r.scope === "user"))
    .map(([id]) => id)
    .sort();
}

export interface PluginPlan {
  /** The account's settings.json. */
  file: string;
  /** Installed plugins its settings don't name: added as off. */
  add: string[];
  /** Entries xclaude added whose plugin is gone, still off: taken out. */
  drop: string[];
  /** What state.json remembers as added for the account afterwards. */
  tracked: string[];
  /** The new settings.json, or null when it stays as it is. */
  text: string | null;
  /** The file as read (null: missing); a different one at write time means Claude Code wrote it. */
  seen: { mtimeMs: number; size: number; ino: number } | null;
}

/**
 * Works out what the account's settings.json needs, without writing anything.
 * Null when there's nothing it can do: no readable registry, an account whose
 * plugins aren't the store's, or settings that are a link, unparsable or not
 * shaped as expected.
 */
export function planPlugins(paths: Paths, account: string, tracked: readonly string[]): PluginPlan | null {
  const dir = accountDir(paths, account);
  if (!lstatOrNull(dir)?.isDirectory()) return null;
  const store = realpathOrNull(path.join(paths.store, "plugins"));
  if (!store || realpathOrNull(path.join(dir, "plugins")) !== store) return null;
  const installed = userPlugins(paths);
  if (!installed) return null;
  const file = path.join(dir, "settings.json");
  const st = lstatOrNull(file);
  if (st && !st.isFile()) return null;
  const original = st ? fs.readFileSync(file, "utf8") : null;
  let settings: unknown = {};
  if (original !== null) {
    try {
      settings = JSON.parse(original);
    } catch {
      return null; // Claude Code reports a broken settings file itself
    }
  }
  if (!isRecord(settings)) return null;
  const current = settings.enabledPlugins ?? {};
  if (!isRecord(current)) return null;

  // Claude Code matches plugin ids without regard to case.
  const named = new Set(Object.keys(current).map((id) => id.toLowerCase()));
  const add = installed.filter((id) => !named.has(id.toLowerCase()));
  const keep: string[] = [];
  const drop: string[] = [];
  for (const id of tracked) {
    if (current[id] !== false) continue; // turned on or taken out: the user's now
    if (installed.includes(id)) keep.push(id);
    else drop.push(id);
  }
  let text: string | null = null;
  if (add.length || drop.length) {
    const next = { ...current };
    for (const id of drop) delete next[id];
    for (const id of add) next[id] = false;
    const ending = original === null || original.endsWith("\n") ? "\n" : "";
    text = `${JSON.stringify({ ...settings, enabledPlugins: next }, null, 2)}${ending}`;
  }
  return {
    file,
    add,
    drop,
    tracked: [...keep, ...add].sort(),
    text,
    seen: st ? { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino } : null,
  };
}

/**
 * Writes a plan's settings.json (the caller holds the store lock). False, with
 * nothing written, when Claude Code wrote the file after it was read.
 */
export function writePlan(plan: PluginPlan): boolean {
  if (plan.text === null) return true;
  const st = lstatOrNull(plan.file);
  const unchanged = plan.seen
    ? st !== null && st.mtimeMs === plan.seen.mtimeMs && st.size === plan.seen.size && st.ino === plan.seen.ino
    : st === null;
  if (unchanged) writeFileAtomic(plan.file, plan.text);
  return unchanged;
}

function changesNothing(plan: PluginPlan, tracked: readonly string[]): boolean {
  return plan.text === null && plan.tracked.join("\n") === [...tracked].sort().join("\n");
}

export interface PluginResult {
  added: string[];
  dropped: string[];
  /** The store lock stayed busy, or Claude Code wrote the settings meanwhile; the next run retries. */
  deferred: boolean;
}

/**
 * Names the plugins installed under other identities in the account's
 * settings.json, as off. Cheap and lock-free when there's nothing to do;
 * otherwise plans again under the store lock. Never throws: a failure is logged.
 */
export function listPlugins(paths: Paths, account: string, opts: { lockWaitMs: number; log: (line: string) => void }): PluginResult {
  const result: PluginResult = { added: [], dropped: [], deferred: false };
  try {
    const before = loadState(paths).listedPlugins[account] ?? [];
    const first = planPlugins(paths, account, before);
    if (!first || changesNothing(first, before)) return result;
    const lock = DirLock.acquire(path.join(paths.locks, "store"), STORE_LOCK, { waitMs: opts.lockWaitMs });
    if (!lock) return { ...result, deferred: true };
    try {
      const tracked = loadState(paths).listedPlugins[account] ?? [];
      const plan = planPlugins(paths, account, tracked);
      if (!plan || changesNothing(plan, tracked)) return result;
      if (!writePlan(plan)) return { ...result, deferred: true };
      updateState(paths, (state) => {
        if (plan.tracked.length) state.listedPlugins[account] = plan.tracked;
        else delete state.listedPlugins[account];
      });
      if (plan.add.length === 1) {
        opts.log(`xclaude: ${plan.add[0]} is installed under another login; ${account}'s /plugin lists it now, turned off`);
      } else if (plan.add.length) {
        opts.log(`xclaude: ${plan.add.length} plugins installed under other logins are in ${account}'s /plugin now, turned off: ${plan.add.join(", ")}`);
      }
      return { added: plan.add, dropped: plan.drop, deferred: false };
    } finally {
      lock.release();
    }
  } catch (e) {
    opts.log(`xclaude: couldn't list other logins' plugins for ${account} (${(e as Error).message})`);
    return result;
  }
}
