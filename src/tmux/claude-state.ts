// The CLAUDE column of `xclaude tmux ls`: working, needs input
// (<waitingFor>), idle or –, from `claude agents --json`. Each live
// Claude pid is mapped to a session by walking parent pids up to a pane pid.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { runClaude } from "../claude/auth.ts";
import { findClaude } from "../claude/resolve.ts";
import { type Config, identities } from "../core/config.ts";
import { XError } from "../core/errors.ts";
import type { Ctx } from "../ctx.ts";
import { identityEnv } from "../launch/env.ts";
import type { Tmux } from "./client.ts";
import type { XSession } from "./sessions.ts";

export interface AgentEntry {
  pid?: number;
  status?: string;
  waitingFor?: string;
}

/** The text for one live session, and how urgent it is (higher wins). */
export function describeAgent(e: AgentEntry): { text: string; rank: number } | null {
  if (e.status === "waiting") return { text: e.waitingFor ? `needs input (${e.waitingFor})` : "needs input", rank: 3 };
  if (e.status === "busy") return { text: "working", rank: 2 };
  if (e.status === "idle") return { text: "idle", rank: 1 };
  return null;
}

type ParentOf = (pid: number) => number | null;

/** Parent pids: /proc on Linux, one `ps -axo pid=,ppid=` call elsewhere. */
export function parentLookup(): ParentOf {
  if (process.platform === "linux" && fs.existsSync("/proc/self/stat")) {
    return (pid) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        // "pid (comm) state ppid …", where comm may contain spaces and parentheses.
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        return Number.isFinite(ppid) ? ppid : null;
      } catch {
        return null;
      }
    };
  }
  const map = new Map<number, number>();
  const res = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 10_000 });
  for (const line of (res.stdout ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined && Number.isFinite(ppid)) map.set(pid, ppid);
  }
  return (pid) => map.get(pid) ?? null;
}

/** The session whose pane is pid itself or one of its ancestors. */
export function sessionOfPid(pid: number, panes: Map<number, string>, parentOf: ParentOf): string | null {
  let current: number | null = pid;
  for (let i = 0; current !== null && current > 1 && i < 64; i++) {
    const session = panes.get(current);
    if (session) return session;
    current = parentOf(current);
  }
  return null;
}

/** Most urgent state per session id, from agents entries. */
export function statesBySession(entries: AgentEntry[], panes: Map<number, string>, parentOf: ParentOf): Map<string, string> {
  const best = new Map<string, { text: string; rank: number }>();
  for (const e of entries) {
    if (typeof e.pid !== "number") continue;
    const state = describeAgent(e);
    if (!state) continue;
    const session = sessionOfPid(e.pid, panes, parentOf);
    if (!session) continue;
    const prev = best.get(session);
    if (!prev || state.rank > prev.rank) best.set(session, state);
  }
  return new Map([...best].map(([k, v]) => [k, v.text]));
}

function panePids(tmux: Tmux): Map<number, string> {
  const panes = new Map<number, string>();
  const res = tmux.run(["list-panes", "-a", "-F", "#{session_id} #{pane_pid}"]);
  for (const line of res.stdout.split("\n")) {
    const [session, pid] = line.trim().split(" ");
    if (session && pid) panes.set(Number(pid), session);
  }
  return panes;
}

async function agents(claude: string, env: Record<string, string>): Promise<AgentEntry[]> {
  const res = await runClaude(claude, ["agents", "--json"], env, 15_000);
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? (parsed as AgentEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * The CLAUDE column for the given sessions. With a shared sessions/ one agents
 * call sees every account's sessions (spike 3); the agentsPerAccount switch
 * makes one call per account instead, in parallel. Never throws: the column
 * just shows – when anything is missing.
 */
export async function claudeStates(ctx: Ctx, config: Config, tmux: Tmux, sessions: XSession[]): Promise<Map<string, string>> {
  const names = identities(config);
  if (!sessions.length || !names.length) return new Map();
  let claude: string;
  try {
    claude = findClaude(ctx.env, config, ctx.paths.home, ctx.selfPath);
  } catch (e) {
    if (e instanceof XError) return new Map();
    throw e;
  }
  const first = sessions.find((s) => s.account && names.includes(s.account))?.account ?? names[0]!;
  const who = ctx.switches.agentsPerAccount ? names : [first];
  const lists = await Promise.all(who.map((n) => agents(claude, identityEnv(ctx, n))));
  const seen = new Set<number>();
  const entries = lists.flat().filter((e) => typeof e.pid !== "number" || (!seen.has(e.pid) && seen.add(e.pid)));
  return statesBySession(entries, panePids(tmux), parentLookup());
}
