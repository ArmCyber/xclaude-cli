// Where everything lives.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export interface Paths {
  /** $HOME */
  home: string;
  /** The shared store, ~/.claude. Also the main identity's config dir. */
  store: string;
  /** xclaude's home: $XCLAUDE_HOME, or ~/.xclaude. */
  xhome: string;
  config: string;
  state: string;
  cache: string;
  shell: string;
  locks: string;
  accounts: string;
}

export function resolvePaths(env: Env): Paths {
  const home = path.resolve(env.HOME || os.homedir());
  // path.resolve makes it absolute and drops trailing slashes, but never resolves
  // links: the account dir strings built from it must stay literal.
  const xhome = path.resolve(env.XCLAUDE_HOME || path.join(home, ".xclaude"));
  return {
    home,
    store: path.join(home, ".claude"),
    xhome,
    config: path.join(xhome, "config.json"),
    state: path.join(xhome, "state.json"),
    cache: path.join(xhome, "cache"),
    shell: path.join(xhome, "shell"),
    locks: path.join(xhome, "locks"),
    accounts: path.join(xhome, "accounts"),
  };
}

/**
 * The CLAUDE_CONFIG_DIR of an account: exactly path.join(<xclaude home>, "accounts", <name>).
 * Never passed through realpath and never with a trailing slash, because the macOS
 * Keychain entry is keyed to the literal string.
 */
export function accountDir(paths: Paths, name: string): string {
  return path.join(paths.xhome, "accounts", name);
}

/** Creates ~/.xclaude with mode 0700 if it's missing. */
export function ensureXHome(paths: Paths): void {
  fs.mkdirSync(paths.xhome, { recursive: true, mode: 0o700 });
}

/** Creates a directory with mode 0700 (account dirs, locks, cache). */
export function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** The real path of p, or null if it doesn't resolve (missing, dangling link, loop). */
export function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/** Shortens a path under $HOME to ~/… for display. */
export function tildify(p: string, home: string): string {
  if (p === home) return "~";
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
