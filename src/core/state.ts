// ~/.xclaude/state.json. Managed by xclaude and written atomically;
// a missing or corrupt file reads as empty, and losing an update is harmless.
import { writeFileAtomic, readFileOrNull } from "./fsutil.ts";
import { ensureXHome, type Paths } from "./paths.ts";

export interface State {
  installedVersion: string | null;
  lastAccountByDir: Record<string, string>;
  lastUsedAccount: string | null;
  seenUnknownEntries: Record<string, string[]>;
}

/** lastAccountByDir keeps the most recently used directories only. */
const MAX_DIRS = 500;

export function emptyState(): State {
  return { installedVersion: null, lastAccountByDir: {}, lastUsedAccount: null, seenUnknownEntries: {} };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadState(paths: Paths): State {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileOrNull(paths.state) ?? "{}");
  } catch {
    return emptyState();
  }
  const state = emptyState();
  if (!isRecord(raw)) return state;
  if (typeof raw.installedVersion === "string") state.installedVersion = raw.installedVersion;
  if (typeof raw.lastUsedAccount === "string") state.lastUsedAccount = raw.lastUsedAccount;
  if (isRecord(raw.lastAccountByDir)) {
    for (const [dir, name] of Object.entries(raw.lastAccountByDir)) {
      if (typeof name === "string") state.lastAccountByDir[dir] = name;
    }
  }
  if (isRecord(raw.seenUnknownEntries)) {
    for (const [name, entries] of Object.entries(raw.seenUnknownEntries)) {
      if (Array.isArray(entries)) state.seenUnknownEntries[name] = entries.filter((e) => typeof e === "string");
    }
  }
  return state;
}

export function saveState(paths: Paths, state: State): void {
  ensureXHome(paths);
  writeFileAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Reads, changes and writes the state in one go, to keep the lost-update window small. */
export function updateState(paths: Paths, change: (state: State) => void): State {
  const state = loadState(paths);
  change(state);
  saveState(paths, state);
  return state;
}

/** Records the account used in a directory. */
export function recordUse(state: State, dir: string, account: string): void {
  delete state.lastAccountByDir[dir]; // re-insert so the newest comes last
  state.lastAccountByDir[dir] = account;
  const dirs = Object.keys(state.lastAccountByDir);
  for (const old of dirs.slice(0, Math.max(0, dirs.length - MAX_DIRS))) delete state.lastAccountByDir[old];
  state.lastUsedAccount = account;
}

/** Drops every mention of a removed account. */
export function forgetAccount(state: State, account: string): void {
  for (const [dir, name] of Object.entries(state.lastAccountByDir)) {
    if (name === account) delete state.lastAccountByDir[dir];
  }
  if (state.lastUsedAccount === account) state.lastUsedAccount = null;
  delete state.seenUnknownEntries[account];
}
