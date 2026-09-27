// Running tmux: without account variables, with trailing `;`
// escaped, always targeting sessions by id.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { isExecutableFile } from "../claude/resolve.ts";
import { XError } from "../core/errors.ts";
import type { Env } from "../core/paths.ts";

/**
 * Never passed to tmux: a server started by xclaude, even from inside a Claude
 * session, must not inherit an account or mark its shells as Claude children
 * (which would switch off the guard). Besides the account variables, this is
 * the per-session environment Claude Code gives its child processes.
 */
export const STRIPPED_ENV: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "XCLAUDE_ACCOUNT",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_INVOKED_SKILLS",
  "CLAUDE_CODE_TMPDIR",
  "CLAUDE_EFFORT",
  "AI_AGENT",
];

export function tmuxEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !STRIPPED_ENV.includes(k)) out[k] = v;
  return out;
}

/** tmux reads a trailing `;` as a command separator; `\;` is a literal one. */
export function escapeArg(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

export interface TmuxResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** How to get tmux, for the messages about it missing. */
export const TMUX_INSTALL_HINT =
  process.platform === "darwin" ? "install it with: brew install tmux" : "install it with your package manager, e.g. sudo apt install tmux";

/** The tmux binary on PATH, or null. */
export function findTmux(env: Env): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "tmux");
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export class Tmux {
  readonly bin: string;
  readonly env: Record<string, string>;

  constructor(env: Env) {
    const bin = findTmux(env);
    if (!bin) throw new XError(`tmux isn't installed (xclaude tmux needs tmux 3.0 or later); ${TMUX_INSTALL_HINT}`);
    this.bin = bin;
    this.env = tmuxEnv(env);
  }

  run(args: string[]): TmuxResult {
    const res = spawnSync(this.bin, args.map(escapeArg), { env: this.env, encoding: "utf8", timeout: 15_000 });
    if (res.error) throw new XError(`running tmux failed: ${res.error.message}`);
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  /** Runs a command that must succeed. */
  must(args: string[]): string {
    const res = this.run(args);
    if (res.code !== 0) throw new XError(`tmux ${args[0]} failed: ${res.stderr.trim() || `exit code ${res.code}`}`);
    return res.stdout;
  }

  /** [major, minor], or null when `tmux -V` can't be read. */
  version(): [number, number] | null {
    const m = /(\d+)\.(\d+)/.exec(this.run(["-V"]).stdout);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }

  requireVersion(): void {
    const v = this.version();
    if (v && (v[0] < 3 || (v[0] === 3 && v[1] < 0))) throw new XError(`tmux ${v.join(".")} is too old; xclaude tmux needs 3.0 or later`);
  }

  /** Whether a session named exactly `name` exists (the = prefix turns off tmux's prefix matching). */
  hasSession(name: string): boolean {
    return this.run(["has-session", "-t", `=${name}`]).code === 0;
  }
}

/** "no server running" and friends: there simply are no sessions (any other connection error is real). */
export function isNoServer(stderr: string): boolean {
  return /no server running|\(No such file or directory\)|server exited unexpectedly/i.test(stderr);
}
