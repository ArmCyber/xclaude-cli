// Driving the sandbox's private tmux server (TMUX_TMPDIR is per sandbox).
import fs from "node:fs";
import path from "node:path";
import { missingTool, type RunResult, type Sandbox } from "./sandbox.ts";

export function hasTmux(sb: Sandbox): boolean {
  return fs.existsSync(path.join(sb.bin, "tmux"));
}

/** Skips the test (loudly) when tmux isn't installed. */
export function needTmux(sb: Sandbox, t: { skip(msg?: string): void }): boolean {
  if (hasTmux(sb)) return true;
  t.skip(missingTool("tmux"));
  return false;
}

export function tmux(sb: Sandbox, args: string[], env?: Record<string, string | undefined>): RunResult {
  return sb.spawn(path.join(sb.bin, "tmux"), args, env ? { env } : {});
}

/** Starts a detached session running `command` through /bin/sh, in a real terminal. */
export function startPane(sb: Sandbox, session: string, command: string, cwd = sb.home): void {
  const res = tmux(sb, ["new-session", "-d", "-s", session, "-x", "120", "-y", "30", "-c", cwd, command]);
  if (res.status !== 0) throw new Error(`tmux new-session failed: ${res.stderr}`);
}

export function capture(sb: Sandbox, target: string): string {
  return tmux(sb, ["capture-pane", "-p", "-t", target]).stdout;
}

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000, show?: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${show ? `; the screen:\n${show()}` : ""}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
