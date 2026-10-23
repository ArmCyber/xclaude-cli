// The environment claude runs with: everything inherited, then the account's
// config dir, without an inherited Keychain override or claude.ai login, and
// with its memory kept in ~/.claude itself.
import { MAIN } from "../core/config.ts";
import { accountDir, type Env, type Paths } from "../core/paths.ts";
import type { State } from "../core/state.ts";
import type { ShareTable } from "../link/table.ts";
import type { Switches } from "../switches.ts";

export interface Identity {
  name: string;
  /** The account's CLAUDE_CONFIG_DIR, or null for the main identity (~/.claude). */
  configDir: string | null;
  /** Where accounts keep their memory (sharedMemoryDir), or null to leave it under the config dir. */
  memoryDir: string | null;
}

/**
 * The folder Claude Code keeps auto memory and `memory: user` subagent memory
 * in (CLAUDE_CODE_REMOTE_MEMORY_DIR, F31): ~/.claude itself, as for plain
 * claude, while projects and agent-memory are shared. Reached through the
 * account's links instead, every memory write would wait for a person's yes,
 * even in auto mode (F30).
 */
export function sharedMemoryDir(paths: Paths, table: ShareTable, switches: Switches): string | null {
  if (!switches.memoryInStore) return null;
  return table.dirs.includes("projects") && table.dirs.includes("agent-memory") ? paths.store : null;
}

/**
 * A claude.ai login in the environment (`claude setup-token` and the variables
 * that provision one). Claude Code uses it before the config dir's own login,
 * whatever CLAUDE_CONFIG_DIR says (F29), so one left in a shell would put every
 * account on that one subscription. Accounts never get these; main does.
 */
export const LOGIN_VARS: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
];

/**
 * Other credentials that come before an account's login too (F29). They're
 * usually set on purpose, and tools run inside a session may need them, so
 * accounts keep them and are told once.
 */
export const CREDENTIAL_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
];

/** The names among `names` that `env` sets to something other than empty or an off value. */
export function setIn(env: Env, names: readonly string[]): string[] {
  return names.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && !/^(0|false|no|off)$/i.test(value);
  });
}

export function buildEnv(base: Env, identity: Identity): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  if (identity.configDir) {
    env.CLAUDE_CONFIG_DIR = identity.configDir;
    // The account signs in with its own login, not one left in the shell (F29).
    for (const name of LOGIN_VARS) delete env[name];
    // Its memory goes straight into ~/.claude (F30); a folder the shell names wins, as it does for plain claude.
    if (identity.memoryDir && !env.CLAUDE_CODE_REMOTE_MEMORY_DIR) env.CLAUDE_CODE_REMOTE_MEMORY_DIR = identity.memoryDir;
  } else {
    delete env.CLAUDE_CONFIG_DIR;
    // An xclaude main started inside an account session would inherit the account's value; plain claude has none.
    if (identity.memoryDir && env.CLAUDE_CODE_REMOTE_MEMORY_DIR === identity.memoryDir) delete env.CLAUDE_CODE_REMOTE_MEMORY_DIR;
  }
  // An inherited value would point the account at another directory's credential (F21).
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  env.XCLAUDE_ACCOUNT = identity.name;
  return env;
}

/**
 * The environment for xclaude's own calls to claude as an identity (auth
 * status, logout, agents --json); the main identity leaves CLAUDE_CONFIG_DIR
 * unset. None of them touches memory, so it stays under the config dir.
 */
export function identityEnv(ctx: { env: Env; paths: Paths }, name: string): Record<string, string> {
  return buildEnv(ctx.env, { name, configDir: name === MAIN ? null : accountDir(ctx.paths, name), memoryDir: null });
}

function joined(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
}

/**
 * What a regular account's launch says about credentials in the shell, once
 * per account and variable: the login variables it leaves out, and the other
 * credentials Claude Code may use instead of the account's login. Records what
 * it said in the state.
 */
export function takeCredentialNotes(state: State, account: string, env: Env): string[] {
  const told = new Set(state.credentialNoted[account] ?? []);
  const dropped = setIn(env, LOGIN_VARS).filter((name) => !told.has(name));
  const others = setIn(env, CREDENTIAL_VARS).filter((name) => !told.has(name));
  const lines: string[] = [];
  if (dropped.length) {
    const [is, it] = dropped.length === 1 ? ["is", "it"] : ["are", "them"];
    lines.push(`xclaude: ${account} signs in with its own login, so ${joined(dropped)} from your shell ${is} left out (plain claude still gets ${it})`);
  }
  if (others.length) {
    const [is, it] = others.length === 1 ? ["is", "it"] : ["are", "them"];
    lines.push(`xclaude: ${joined(others)} ${is} set in your shell, so Claude Code may use ${it} instead of ${account}'s own login (/status shows which)`);
  }
  if (lines.length) state.credentialNoted[account] = [...told, ...dropped, ...others].sort();
  return lines;
}
