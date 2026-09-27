// Replacing xclaude with claude, also used by `tmux attach`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { directlyExecutable, isEmptyFile, shellWay } from "../claude/runnable.ts";
import { XError } from "../core/errors.ts";

export { directlyExecutable, isShellScript } from "../claude/runnable.ts";

/**
 * Node ignores SIGPIPE and SIGXFSZ, and ignored signals survive execve: claude
 * (and the shells it runs) would inherit that. Adding and removing a listener
 * puts the default action back.
 */
function restoreDefaultSignals(): void {
  const noop = () => {};
  for (const sig of ["SIGPIPE", "SIGXFSZ"] as const) {
    process.on(sig, noop);
    process.off(sig, noop);
  }
}

/**
 * Runs `file` with `argv` (argv[0] included) and `env`. The real one never
 * returns (execve); the spawn fallback resolves with the exit code to use.
 * Injectable, so tests can check exactly what would run.
 */
export type ExecFn = (file: string, argv: string[], env: Record<string, string>) => Promise<number>;

export function makeExec(opts: { spawnFallback: boolean }): ExecFn {
  return async (file, argv, env) => {
    // A failed execve aborts Node before v26.1 and can't be caught, so
    // check what can be checked first.
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      throw new XError(`${file} isn't executable`);
    }
    if (isEmptyFile(file)) throw new XError(`${file} is empty, so there's nothing to run`);
    // Shells run a script without #! with sh, and so does xclaude: execve can't, and
    // macOS's posix_spawn (unlike glibc's execvp) doesn't fall back to sh either.
    const [runFile, args] = shellWay(file, argv.slice(1));
    const runArgv = runFile === file ? argv : ["sh", ...args];
    if (!opts.spawnFallback && typeof process.execve === "function" && directlyExecutable(runFile)) {
      restoreDefaultSignals();
      try {
        process.execve(runFile, runArgv, env);
      } catch (e) {
        // From Node 26.1 a failed execve throws instead of aborting.
        throw new XError(`couldn't start ${file}: ${(e as Error).message}`);
      }
    }
    return spawnAndMirror(runFile, args, env);
  };
}

/**
 * The spawn fallback: a child with inherited stdio. The parent ignores SIGINT
 * and SIGQUIT (the child gets them from the terminal), forwards SIGTERM and
 * SIGHUP, and ends the same way the child did: its exit code, or its signal.
 */
export function spawnAndMirror(file: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", env });
    const ignore = () => {};
    const forwardTerm = () => child.kill("SIGTERM");
    const forwardHup = () => child.kill("SIGHUP");
    process.on("SIGINT", ignore);
    process.on("SIGQUIT", ignore);
    process.on("SIGTERM", forwardTerm);
    process.on("SIGHUP", forwardHup);
    const cleanup = () => {
      process.off("SIGINT", ignore);
      process.off("SIGQUIT", ignore);
      process.off("SIGTERM", forwardTerm);
      process.off("SIGHUP", forwardHup);
    };
    child.on("error", (e) => {
      cleanup();
      reject(new XError(`couldn't start ${file}: ${e.message}`));
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (signal) {
        // With our handlers gone the default action applies: end by the same signal.
        process.kill(process.pid, signal);
        resolve(128 + (os.constants.signals[signal] ?? 0));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * Runs a program in the foreground and waits for it (used by `add`, which
 * continues afterwards). SIGINT and SIGQUIT go to the child from the terminal.
 */
export function runChild(file: string, args: string[], env: Record<string, string>): Promise<number> {
  if (isEmptyFile(file)) return Promise.reject(new XError(`${file} is empty, so there's nothing to run`));
  return new Promise((resolve, reject) => {
    const child = spawn(...shellWay(file, args), { stdio: "inherit", env });
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGQUIT", ignore);
    const done = () => {
      process.off("SIGINT", ignore);
      process.off("SIGQUIT", ignore);
    };
    child.on("error", (e) => {
      done();
      reject(new XError(`couldn't start ${file}: ${e.message}`));
    });
    child.on("exit", (code, signal) => {
      done();
      resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1));
    });
  });
}
