// Choices the spikes settled (spikes/run.ts), each a one-line flip.
// XCLAUDE_SWITCHES="name=1,name=0" overrides them for one run: the tests use it,
// and so can anyone rerunning a spike, without a rebuild.
import type { Env } from "./core/paths.ts";

export interface Switches {
  /** Spike 3: share `sessions` (off: per account). */
  shareSessions: boolean;
  /** Spike 3: call `claude agents --json` once per account instead of once for all. */
  agentsPerAccount: boolean;
  /** Spike 4: share `history.jsonl` (off: per account). */
  shareHistory: boolean;
  /** Spike 5: share `skills` (off: per account). */
  shareSkills: boolean;
  /** Spike 7: share `chrome` (off: per account). */
  shareChrome: boolean;
  /** Spike 9: spawn claude as a child process instead of replacing the process with execve. */
  spawnFallback: boolean;
  /** Spike 11: link `ide` after all. */
  linkIde: boolean;
  /** Spike 13: rewrite account-dir paths in the plugin registry. */
  normalizePaths: boolean;
  /** Spike 14: `rm` skips logout when another identity uses the same email (off: spike 14 showed it's safe). */
  keepSameEmailLogin: boolean;
}

export const SWITCHES: Readonly<Switches> = {
  shareSessions: true,
  agentsPerAccount: false,
  shareHistory: true,
  shareSkills: true,
  shareChrome: true,
  spawnFallback: false,
  linkIde: false,
  normalizePaths: false,
  keepSameEmailLogin: false,
};

/** The built-in switches with XCLAUDE_SWITCHES applied; unknown names are ignored. */
export function loadSwitches(env: Env): Switches {
  const switches: Switches = { ...SWITCHES };
  for (const item of (env.XCLAUDE_SWITCHES ?? "").split(",")) {
    const [name = "", value = "1"] = item.trim().split("=");
    if (Object.hasOwn(switches, name)) switches[name as keyof Switches] = value === "1" || value === "true";
  }
  return switches;
}
