// A throwaway machine for one test: temp HOME, XCLAUDE_HOME, TMUX_TMPDIR and
// XDG_CONFIG_HOME, plus a clean environment built from an allowlist. Nothing is
// inherited from the parent: agents run these tests inside Claude Code, and an
// inherited ZDOTDIR, TMUX or CLAUDE_CONFIG_DIR could reach the owner's real setup.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleepSync } from "../../src/core/sleep.ts";

export const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const distCli = path.join(repoRoot, "dist", "xclaude.js");
export const fakeClaude = path.join(repoRoot, "test", "fake-claude", "claude.mjs");
export const fixtures = path.join(repoRoot, "test", "fixtures");

export type Env = Record<string, string>;

export interface FakeCall {
  argv: string[];
  env: Env;
  cwd: string;
  pid: number;
  event?: string;
  signal?: string;
}

export interface RunResult {
  pid: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  input?: string;
  timeout?: number;
}

export interface Sandbox {
  root: string;
  home: string;
  xhome: string;
  store: string;
  bin: string;
  tmuxTmp: string;
  fakeLog: string;
  env: Env;
  /** Runs the built xclaude with the sandbox environment. */
  run(args: string[], opts?: RunOptions): RunResult;
  /** Runs any program with the sandbox environment. */
  spawn(file: string, args: string[], opts?: RunOptions): RunResult;
  /** Calls the fake claude recorded so far. */
  fakeCalls(): FakeCall[];
  /** Environment with extra variables set, or removed when the value is undefined. */
  envWith(extra?: Record<string, string | undefined>): Env;
  cleanup(): void;
}

/** Finds a program on the host PATH (used only to locate tools like tmux and zsh). */
export function findTool(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** A skip message that stands out in the test output. */
export function missingTool(name: string): string {
  const msg = `*** ${name} not found: its tests are SKIPPED. Install ${name} to run them.`;
  process.stderr.write(`${msg}\n`);
  return msg;
}

function defaultLang(): string {
  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

/** A directory whose tmux socket path stays under the 104-byte sun_path limit. */
function shortTempDir(prefix: string): string {
  const base = os.tmpdir();
  const probe = path.join(base, `${prefix}XXXXXX`, "tmux-999999", "default");
  return fs.mkdtempSync(path.join(probe.length < 100 ? base : "/tmp", prefix));
}

export function makeSandbox(): Sandbox {
  if (!fs.existsSync(distCli)) throw new Error(`${distCli} is missing: run npm run build first`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xclaude-test-")));
  const home = path.join(root, "home");
  const xhome = path.join(home, ".xclaude");
  const store = path.join(home, ".claude");
  const bin = path.join(root, "bin");
  const tmuxTmp = shortTempDir("xct-");
  const fakeLog = path.join(root, "fake-claude.jsonl");
  fs.mkdirSync(home, { recursive: true });
  // tmux starts pane shells as login shells, which read the system profile: Debian's
  // resets PATH and macOS's path_helper puts system dirs (and any older node) first,
  // so a command typed into a pane wouldn't find the sandbox's xclaude and Node.
  fs.writeFileSync(path.join(home, ".tmux.conf"), 'set -g default-command "exec /bin/sh"\n');
  fs.mkdirSync(bin);
  fs.symlinkSync(distCli, path.join(bin, "xclaude"));
  fs.symlinkSync(fakeClaude, path.join(bin, "claude"));
  // Host tools the tests may need, exposed one by one instead of adding their dirs to PATH.
  for (const tool of ["tmux", "zsh"]) {
    const found = findTool(tool);
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }

  const env: Env = {
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    HOME: home,
    XCLAUDE_HOME: xhome,
    TMUX_TMPDIR: tmuxTmp,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SHELL: "/bin/sh",
    TERM: process.env.TERM || "xterm-256color",
    LANG: process.env.LANG || defaultLang(),
    XCLAUDE_CLAUDE_PATH: path.join(bin, "claude"),
    XCLAUDE_MANAGED_SETTINGS_DIR: path.join(root, "managed"),
    FAKE_CLAUDE_LOG: fakeLog,
    // A zsh installed outside the usual prefix (no sudo) needs its function path.
    ...(process.env.FPATH ? { FPATH: process.env.FPATH } : {}),
  };

  const envWith = (extra: Record<string, string | undefined> = {}): Env => {
    const out: Env = { ...env };
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  };

  const spawn = (file: string, args: string[], opts: RunOptions = {}): RunResult => {
    const started = performance.now();
    const res: SpawnSyncReturns<string> = spawnSync(file, args, {
      env: envWith(opts.env),
      cwd: opts.cwd ?? home,
      input: opts.input ?? "",
      encoding: "utf8",
      timeout: opts.timeout ?? 30_000,
    });
    if (res.error) throw res.error;
    return {
      pid: res.pid,
      status: res.status,
      signal: res.signal,
      stdout: res.stdout,
      stderr: res.stderr,
      ms: performance.now() - started,
    };
  };

  return {
    root,
    home,
    xhome,
    store,
    bin,
    tmuxTmp,
    fakeLog,
    env,
    envWith,
    spawn,
    run: (args, opts) => spawn(path.join(bin, "xclaude"), args, opts),
    fakeCalls: () =>
      fs.existsSync(fakeLog)
        ? fs
            .readFileSync(fakeLog, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as FakeCall)
        : [],
    cleanup: () => {
      const tmuxBin = path.join(bin, "tmux");
      if (fs.existsSync(tmuxBin)) {
        // Processes in the panes outlive kill-server for a moment and could still write into the
        // sandbox after it's removed. Each pane is its own session: kill those first, and wait.
        const panes = spawnSync(tmuxBin, ["list-panes", "-a", "-F", "#{pane_pid}"], { env, encoding: "utf8" });
        const sids = (panes.stdout ?? "").split("\n").filter(Boolean).join(",");
        if (sids) {
          const host = { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" } as const;
          spawnSync("pkill", ["-KILL", "-s", sids], host);
          for (let i = 0; i < 60 && spawnSync("pgrep", ["-s", sids], host).status === 0; i++) sleepSync(50);
        }
        spawnSync(tmuxBin, ["kill-server"], { env, stdio: "ignore" });
      }
      removeTree(root);
      removeTree(tmuxTmp);
    },
  };
}

/**
 * Removes a sandbox folder. A process that was still exiting can write a last
 * line (the fake claude logs the signal) while the tree is removed, so the
 * removal is retried for up to 2 s.
 */
function removeTree(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 40) throw e;
      sleepSync(50);
    }
  }
}

/** Writes a fake login into an account's config dir (read by the fake claude). */
export function fakeLogin(configDir: string, login: { email: string; orgId: string; orgName?: string }): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify(login));
}
