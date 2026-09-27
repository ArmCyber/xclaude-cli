// Path normalization (off: spike 13 showed Claude Code doesn't use recorded
// plugin paths as written). The plugin registry records
// absolute paths under the installing account's dir; rewriting them to
// $HOME/.claude/… (the form the main identity writes) keeps plugins working for
// everyone after that account is removed. Only small registry files are
// rewritten, never transcripts or other content.
import fs from "node:fs";
import path from "node:path";
import { lstatOrNull, writeFileAtomic } from "../core/fsutil.ts";
import { DirLock, STORE_LOCK } from "../core/lock.ts";
import { type Paths, realpathOrNull, tildify } from "../core/paths.ts";

/** Path-bearing registry files in shared folders. */
export const REGISTRY_FILES: readonly string[] = ["plugins/installed_plugins.json", "plugins/known_marketplaces.json"];

export interface NormalizationPlan {
  file: string;
  text: string;
  /** What the file looked like when read; a different one on write means Claude Code wrote it. */
  mtimeMs: number;
  size: number;
  ino: number;
  count: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrites matching string values anywhere in a parsed JSON value; returns how many changed. */
function rewrite(value: unknown, re: RegExp, to: string, onChange: () => void): unknown {
  if (typeof value === "string") {
    const next = value.replace(re, (_m, _name: string, sep: string) => `${to}${sep}`);
    if (next !== value) onChange();
    return next;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, re, to, onChange));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, re, to, onChange);
    return out;
  }
  return value;
}

/**
 * Reads the registry files and works out the rewrites, without writing
 * anything. `account` limits it to one account's prefix (used by rm).
 */
export function planNormalization(paths: Paths, account?: string): NormalizationPlan[] {
  const accountsDir = path.join(paths.xhome, "accounts");
  const to = path.join(paths.home, ".claude");
  const name = account ? escapeRe(account) : "[a-z][a-z0-9-]{0,31}";
  const re = new RegExp(`^${escapeRe(accountsDir)}/(${name})(/|$)`);
  const plans: NormalizationPlan[] = [];
  for (const rel of REGISTRY_FILES) {
    const file = realpathOrNull(path.join(paths.store, rel));
    if (!file) continue;
    const st = lstatOrNull(file);
    if (!st?.isFile()) continue;
    const original = fs.readFileSync(file, "utf8");
    if (!original.includes(accountsDir)) continue; // the cheap check that usually ends here
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch {
      continue; // mid-write or not ours to fix
    }
    let count = 0;
    const next = rewrite(parsed, re, to, () => count++);
    if (!count) continue;
    const text = `${JSON.stringify(next, null, 2)}${original.endsWith("\n") ? "\n" : ""}`;
    plans.push({ file, text, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, count });
  }
  return plans;
}

/**
 * Writes planned rewrites (the caller holds the store lock). A file Claude Code
 * wrote after it was read is skipped this time; the next run retries.
 */
export function applyNormalization(plans: NormalizationPlan[]): { changed: string[]; skipped: string[] } {
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const plan of plans) {
    const st = lstatOrNull(plan.file);
    if (!st || st.mtimeMs !== plan.mtimeMs || st.size !== plan.size || st.ino !== plan.ino) {
      skipped.push(plan.file);
      continue;
    }
    writeFileAtomic(plan.file, plan.text);
    changed.push(plan.file);
  }
  return { changed, skipped };
}

export interface NormalizeResult {
  changed: string[];
  skipped: string[];
  /** The store lock stayed busy; nothing was written. */
  busy: boolean;
}

/** Plans, then applies under the store lock. Cheap when nothing needs rewriting. */
export function normalizePaths(
  paths: Paths,
  opts: { account?: string; lockWaitMs: number; log: (line: string) => void },
): NormalizeResult {
  const plans = planNormalization(paths, opts.account);
  if (!plans.length) return { changed: [], skipped: [], busy: false };
  const lock = DirLock.acquire(path.join(paths.locks, "store"), STORE_LOCK, { waitMs: opts.lockWaitMs });
  if (!lock) return { changed: [], skipped: plans.map((p) => p.file), busy: true };
  try {
    const result = applyNormalization(plans);
    for (const plan of plans.filter((p) => result.changed.includes(p.file))) {
      opts.log(`xclaude: rewrote ${plan.count} account-dir path${plan.count > 1 ? "s" : ""} in ${tildify(plan.file, paths.home)} to ~/.claude/…`);
    }
    return { ...result, busy: false };
  } finally {
    lock.release();
  }
}
