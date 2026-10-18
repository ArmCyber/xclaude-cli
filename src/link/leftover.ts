// Leftover folders of removed accounts. Claude Code records some paths
// through the config dir it ran under, such as the saved output of a large tool
// result, so `rm` keeps an account's links into ~/.claude: those paths keep working
// after the account is gone. Running `rm` on the name again deletes them.
import fs from "node:fs";
import path from "node:path";
import { accountNameProblem, type Config } from "../core/config.ts";
import { lstatOrNull, readFileOrNull, removeTree } from "../core/fsutil.ts";
import { accountDir, type Paths } from "../core/paths.ts";
import { STUB_TEXT } from "./stub.ts";
import { HISTORY, isIgnored, isKnown, SHARED_DIRS, type ShareTable, STUB } from "./table.ts";

/**
 * A folder in accounts/ that isn't an account in the config:
 * - `leftover`: holds only links, as `rm` leaves it, so it can be deleted;
 * - `content`: holds more than links (a login, real shared content, an interrupted merge…);
 * - `stray`: its name couldn't be an account's (a backup copy, say);
 * - `link`: the folder itself is a symlink.
 * Only a `leftover` is ever deleted by xclaude.
 */
export interface Folder {
  name: string;
  dir: string;
  kind: "leftover" | "content" | "stray" | "link";
  /** For `content`: what isn't a link. */
  entries: string[];
}

/** The folders in accounts/ that aren't accounts in the config. */
export function strayFolders(paths: Paths, config: Config): Folder[] {
  let names: string[];
  try {
    names = fs.readdirSync(paths.accounts);
  } catch {
    return [];
  }
  // On a case-insensitive volume another spelling of an account's name is that account's folder.
  const accounts = Object.keys(config.accounts)
    .map((n) => lstatOrNull(accountDir(paths, n)))
    .filter((st): st is fs.Stats => st !== null);
  const out: Folder[] = [];
  for (const name of names.sort()) {
    if (name.endsWith(".lock") || name === ".DS_Store" || Object.hasOwn(config.accounts, name)) continue;
    const dir = path.join(paths.accounts, name);
    const st = lstatOrNull(dir);
    if (!st) continue;
    if (st.isSymbolicLink()) out.push({ name, dir, kind: "link", entries: [] });
    else if (!st.isDirectory() || accounts.some((a) => a.dev === st.dev && a.ino === st.ino)) continue;
    else if (accountNameProblem(name)) out.push({ name, dir, kind: "stray", entries: [] });
    else {
      const entries = fs.readdirSync(dir).filter((e) => e !== ".DS_Store" && !lstatOrNull(path.join(dir, e))?.isSymbolicLink());
      out.push({ name, dir, kind: entries.length ? "content" : "leftover", entries });
    }
  }
  return out;
}

/** The names of the leftovers that can be deleted. */
export function leftoverNames(paths: Paths, config: Config): string[] {
  return strayFolders(paths, config)
    .filter((f) => f.kind === "leftover")
    .map((f) => f.name);
}

/** The names a leftover keeps as links: every shared entry. */
function linkNames(table: ShareTable): Set<string> {
  return new Set([...SHARED_DIRS, ...table.dirs, HISTORY]);
}

/** Whether a real entry holds anything: a non-empty folder or file. */
function hasContent(p: string): boolean {
  const st = lstatOrNull(p);
  if (!st) return false;
  if (st.isDirectory()) return fs.readdirSync(p).some((e) => e !== ".DS_Store");
  return st.size > 0;
}

/** Something the user made in the account: a CLAUDE.md that isn't just the stub (/memory writes there), or an entry xclaude doesn't know. */
function madeByUser(p: string, name: string, table: ShareTable): boolean {
  if (name === STUB) return !(lstatOrNull(p)?.isFile() && readFileOrNull(p) === STUB_TEXT);
  return !isKnown(name, table) && !isIgnored(name);
}

/**
 * Turns a removed account's folder into its leftover. The links into ~/.claude stay,
 * and so does what the account made itself: content under a shared name (its own
 * skills while skills aren't shared, say), a CLAUDE.md with more than the stub, and
 * entries xclaude doesn't know. Everything else (login, settings, caches, the
 * CLAUDE.md stub) goes, never following a link. A folder left empty is removed.
 * Returns the entries kept as real content.
 */
export function keepOnlyLinks(dir: string, table: ShareTable): { kept: boolean; content: string[] } {
  if (lstatOrNull(dir)?.isSymbolicLink()) throw new Error(`${dir} is a symlink`);
  const shared = linkNames(table);
  const content: string[] = [];
  let links = 0;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (shared.has(name) && lstatOrNull(p)?.isSymbolicLink()) links++;
    else if ((shared.has(name) || madeByUser(p, name, table)) && hasContent(p)) content.push(name);
    else removeTree(p);
  }
  if (links || content.length) return { kept: true, content };
  fs.rmdirSync(dir);
  return { kept: false, content };
}
