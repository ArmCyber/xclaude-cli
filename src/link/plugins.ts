// Plugins installed under another identity. The plugin registry is shared, but
// which plugins are on is each account's settings.json, and /plugin lists as
// installed only the plugins those settings name (F25): one installed under
// another identity is missing there, so there's nowhere to turn it on. xclaude
// names it there: on when ~/.claude has it on and the account takes ~/.claude's
// settings (link/inherit.ts), off otherwise. It remembers what it wrote
// (state.json). An entry still holding that value is xclaude's: it follows
// ~/.claude turning the plugin on or off, and goes once the plugin is
// uninstalled. One the user changed is theirs, and left alone.
import fs from "node:fs";
import path from "node:path";
import { type FileStamp, lstatOrNull, readFileOrNull, stampOf, writeIfUnchanged } from "../core/fsutil.ts";
import { DirLock, STORE_LOCK } from "../core/lock.ts";
import { accountDir, type Paths, realpathOrNull } from "../core/paths.ts";
import { loadState, updateState } from "../core/state.ts";
import { mainSettings } from "./inherit.ts";

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

/** The plugins ~/.claude/settings.json turns on, ids lowercased; null when it can't be read. */
export function mainPlugins(paths: Paths): Set<string> | null {
  const read = mainSettings(paths);
  if ("problem" in read) return null;
  const enabled = read.settings.enabledPlugins;
  if (!isRecord(enabled)) return new Set();
  return new Set(
    Object.entries(enabled)
      .filter(([, on]) => on === true)
      .map(([id]) => id.toLowerCase()),
  );
}

/** The entries xclaude wrote into an account's enabledPlugins, as off and as on. */
export interface Tracked {
  off: readonly string[];
  on: readonly string[];
}

export interface PluginPlan {
  /** The account's settings.json. */
  file: string;
  /** Installed plugins its settings don't name: added, off unless turnOn names them. */
  add: string[];
  /** Plugins turned on because ~/.claude has them on: new entries, and xclaude's own off ones. */
  turnOn: string[];
  /** xclaude's own on entries turned off, because ~/.claude has them off now. */
  turnOff: string[];
  /** Entries xclaude wrote whose plugin is gone, still as written: taken out. */
  drop: string[];
  /** What state.json remembers as written for the account afterwards. */
  tracked: { off: string[]; on: string[] };
  /** The new settings.json, or null when it stays as it is. */
  text: string | null;
  /** The file as read (null: missing); a different one at write time means Claude Code wrote it. */
  seen: FileStamp | null;
}

/**
 * Works out what the account's settings.json needs, without writing anything.
 * Null when there's nothing it can do: no readable registry, an account whose
 * plugins aren't the store's, or settings that are a link, unparsable or not
 * shaped as expected. With `follow` (the plugins ~/.claude turns on), new entries
 * and xclaude's own ones take ~/.claude's value; without, new entries are off and
 * xclaude's own keep theirs.
 */
export function planPlugins(paths: Paths, account: string, tracked: Tracked, follow: ReadonlySet<string> | null = null): PluginPlan | null {
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
  const wanted = (id: string) => follow?.has(id.toLowerCase()) === true;
  const named = new Set(Object.keys(current).map((id) => id.toLowerCase()));
  const add = installed.filter((id) => !named.has(id.toLowerCase()));
  const next: Record<string, unknown> = { ...current };
  const off: string[] = [];
  const on: string[] = [];
  const turnOn: string[] = [];
  const turnOff: string[] = [];
  const drop: string[] = [];
  for (const [ids, value] of [
    [tracked.off, false],
    [tracked.on, true],
  ] as const) {
    for (const id of ids) {
      if (current[id] !== value) continue; // changed or taken out: the user's now
      if (!installed.includes(id)) {
        drop.push(id);
        delete next[id];
      } else if (follow && wanted(id) !== value) {
        next[id] = !value;
        (value ? turnOff : turnOn).push(id);
        (value ? off : on).push(id);
      } else (value ? on : off).push(id);
    }
  }
  for (const id of add) {
    next[id] = wanted(id);
    if (wanted(id)) {
      on.push(id);
      turnOn.push(id);
    } else off.push(id);
  }
  let text: string | null = null;
  if (add.length || drop.length || turnOn.length || turnOff.length) {
    const ending = original === null || original.endsWith("\n") ? "\n" : "";
    text = `${JSON.stringify({ ...settings, enabledPlugins: next }, null, 2)}${ending}`;
  }
  return {
    file,
    add,
    turnOn,
    turnOff,
    drop,
    tracked: { off: off.sort(), on: on.sort() },
    text,
    seen: stampOf(st),
  };
}

/**
 * Writes a plan's settings.json (the caller holds the store lock). False, with
 * nothing written, when Claude Code wrote the file after it was read.
 */
export function writePlan(plan: PluginPlan): boolean {
  return plan.text === null || writeIfUnchanged(plan.file, plan.text, plan.seen);
}

function changesNothing(plan: PluginPlan, tracked: Tracked): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.join("\n") === [...b].sort().join("\n");
  return plan.text === null && same(plan.tracked.off, tracked.off) && same(plan.tracked.on, tracked.on);
}

/** The plugin entries xclaude wrote to the account's settings.json, from the state. */
export function trackedOf(paths: Paths, account: string): Tracked {
  const state = loadState(paths);
  return { off: state.listedPlugins[account] ?? [], on: state.turnedOnPlugins[account] ?? [] };
}

export interface PluginResult {
  added: string[];
  dropped: string[];
  /** The store lock stayed busy, or Claude Code wrote the settings meanwhile; the next run retries. */
  deferred: boolean;
}

/**
 * Names the plugins installed under other identities in the account's
 * settings.json. With `follow` (an account that takes ~/.claude's settings), a
 * plugin ~/.claude has on is on, and xclaude's own entries follow ~/.claude; with
 * `turnOffOwn` (--inherit off), the ones xclaude turned on go back off. Cheap and
 * lock-free when there's nothing to do; otherwise plans again under the store
 * lock. Never throws: a failure is logged.
 */
export function listPlugins(
  paths: Paths,
  account: string,
  opts: { lockWaitMs: number; log: (line: string) => void; follow?: boolean; turnOffOwn?: boolean },
): PluginResult {
  const result: PluginResult = { added: [], dropped: [], deferred: false };
  try {
    const follow = opts.turnOffOwn ? new Set<string>() : opts.follow ? mainPlugins(paths) : null;
    const before = trackedOf(paths, account);
    const first = planPlugins(paths, account, before, follow);
    if (!first || changesNothing(first, before)) return result;
    const lock = DirLock.acquire(path.join(paths.locks, "store"), STORE_LOCK, { waitMs: opts.lockWaitMs });
    if (!lock) return { ...result, deferred: true };
    try {
      const tracked = trackedOf(paths, account);
      const plan = planPlugins(paths, account, tracked, follow);
      if (!plan || changesNothing(plan, tracked)) return result;
      if (!writePlan(plan)) return { ...result, deferred: true };
      updateState(paths, (state) => {
        for (const [key, ids] of [
          ["listedPlugins", plan.tracked.off],
          ["turnedOnPlugins", plan.tracked.on],
        ] as const) {
          if (ids.length) state[key][account] = ids;
          else delete state[key][account];
        }
      });
      const off = plan.add.filter((id) => !plan.turnOn.includes(id));
      if (off.length === 1) {
        opts.log(`xclaude: ${off[0]} is installed under another login; ${account}'s /plugin lists it now, turned off`);
      } else if (off.length) {
        opts.log(`xclaude: ${off.length} plugins installed under other logins are in ${account}'s /plugin now, turned off: ${off.join(", ")}`);
      }
      if (plan.turnOn.length) opts.log(`xclaude: ${account} turned on what ~/.claude has on: ${plan.turnOn.join(", ")}`);
      if (plan.turnOff.length) opts.log(`xclaude: ${account} turned off ${plan.turnOff.join(", ")}, which ${opts.turnOffOwn ? "it had from ~/.claude" : "~/.claude has off now"}`);
      return { added: plan.add, dropped: plan.drop, deferred: false };
    } finally {
      lock.release();
    }
  } catch (e) {
    opts.log(`xclaude: couldn't list other logins' plugins for ${account} (${(e as Error).message})`);
    return result;
  }
}
