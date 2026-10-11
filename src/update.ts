// The update check. Once a day, opening xclaude starts a background process that
// asks the npm registry for the latest version and keeps the answer in
// ~/.xclaude/cache/update-check.json. While that version is newer than this
// one, every open prints a one-line note. A failed check (offline, registry
// down) is silent and isn't recorded, so the next open tries again.
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import path from "node:path";
import { readFileOrNull, writeFileAtomic } from "./core/fsutil.ts";
import { type Env, mkdirPrivate, type Paths } from "./core/paths.ts";
import type { Ctx } from "./ctx.ts";

export const PACKAGE = "xclaude-cli";
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface UpdateCheck {
  /** When the registry last answered (ms since the epoch). */
  checkedAt: number;
  /** The `latest` version it named. */
  latest: string;
}

function checkFile(paths: Paths): string {
  return path.join(paths.cache, "update-check.json");
}

/** The last successful check, or null when there's none (or it's unreadable). */
export function readUpdateCheck(paths: Paths): UpdateCheck | null {
  try {
    const raw = JSON.parse(readFileOrNull(checkFile(paths)) ?? "null") as Partial<UpdateCheck> | null;
    if (typeof raw?.checkedAt === "number" && typeof raw.latest === "string") return { checkedAt: raw.checkedAt, latest: raw.latest };
  } catch {
    // a corrupt file counts as no check
  }
  return null;
}

/** A check is due without a previous one, a day after it, or when the clock went back. */
export function checkDue(check: UpdateCheck | null, now: number): boolean {
  return !check || now - check.checkedAt >= CHECK_INTERVAL_MS || now < check.checkedAt;
}

/** Whether version a is newer than b. A prerelease is older than its release; anything unparsable never is newer. */
export function isNewer(a: string, b: string): boolean {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff) return diff > 0;
  }
  return pa[4] === undefined && pb[4] !== undefined;
}

/** The version the registry calls latest, or null on any failure. */
export async function fetchLatest(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown } | null;
    return typeof body?.version === "string" && SEMVER.test(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

/** The background half (`xclaude __update-check`): asks the registry and records the answer. */
export async function runUpdateCheck(paths: Paths, url: string, now: () => number = Date.now): Promise<void> {
  const latest = await fetchLatest(url);
  if (!latest) return;
  try {
    mkdirPrivate(paths.cache);
    const check: UpdateCheck = { checkedAt: now(), latest };
    writeFileAtomic(checkFile(paths), `${JSON.stringify(check)}\n`, { mode: 0o600 });
  } catch {
    // the next open checks again
  }
}

/**
 * Starts `xclaude __update-check` in the background and returns at once (a few
 * ms). It goes through `sh -c '… &'` in a new session, so it's orphaned right
 * away: claude, which replaces xclaude through execve, never inherits it as a
 * child, and closing the terminal doesn't stop it.
 */
export function startUpdateCheck(env: Env, script: string): void {
  // spawnSync honors `detached` (setsid) as spawn does; @types/node leaves it out.
  const opts = { env, stdio: "ignore", detached: true, timeout: 2000 } as SpawnSyncOptions;
  try {
    spawnSync("/bin/sh", ["-c", '"$0" "$1" __update-check </dev/null >/dev/null 2>&1 &', process.execPath, script], opts);
  } catch {
    // the next open tries again
  }
}

export function updateNote(latest: string, current: string): string {
  return `xclaude: an update is available (${current} → ${latest}); please run npm install -g ${PACKAGE} to update`;
}

/**
 * Runs on every open that someone sees (stderr is a terminal): the note when a
 * newer version is known, and a new check in the background once a day.
 * XCLAUDE_NO_UPDATE_CHECK=1 turns both off; XCLAUDE_UPDATE_URL replaces the
 * registry URL (tests use it).
 */
export function updateCheckOnOpen(ctx: Ctx, version: string, now = Date.now()): void {
  if (!ctx.tty.stderr || ctx.env.XCLAUDE_NO_UPDATE_CHECK === "1") return;
  const check = readUpdateCheck(ctx.paths);
  if (check && isNewer(check.latest, version)) ctx.io.err(`${updateNote(check.latest, version)}\n`);
  if (checkDue(check, now) && ctx.selfPath) startUpdateCheck(ctx.env, ctx.selfPath);
}
