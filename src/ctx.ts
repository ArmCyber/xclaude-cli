// Everything a command needs from the outside world, in one place, so tests can
// substitute any part of it.
import tty from "node:tty";
import type { Io } from "./core/io.ts";
import { type Env, type Paths, resolvePaths } from "./core/paths.ts";
import { type ExecFn, makeExec } from "./launch/exec.ts";
import { loadSwitches, type Switches } from "./switches.ts";

export interface Ctx {
  env: Env;
  cwd: string;
  paths: Paths;
  io: Io;
  tty: { stdin: boolean; stdout: boolean; stderr: boolean };
  switches: Switches;
  /** Replaces the process with claude (or tmux); injectable for tests. */
  exec: ExecFn;
  /** The running xclaude script, so a `claude` on PATH that is xclaude itself is skipped. */
  selfPath: string | null;
}

export function processCtx(io: Io): Ctx {
  const switches = loadSwitches(process.env);
  return {
    env: process.env,
    cwd: process.cwd(),
    paths: resolvePaths(process.env),
    io,
    // tty.isatty, never process.stdin.isTTY: touching Node's stdio streams makes
    // a terminal fd non-blocking, and claude would inherit that through exec.
    tty: { stdin: tty.isatty(0), stdout: tty.isatty(1), stderr: tty.isatty(2) },
    switches,
    exec: makeExec({ spawnFallback: switches.spawnFallback }),
    selfPath: process.argv[1] ?? null,
  };
}
