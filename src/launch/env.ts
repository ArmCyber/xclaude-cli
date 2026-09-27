// The environment claude runs with: everything inherited, then
// the account's config dir, and no inherited Keychain override.
import { MAIN } from "../core/config.ts";
import { accountDir, type Env, type Paths } from "../core/paths.ts";

export interface Identity {
  name: string;
  /** The account's CLAUDE_CONFIG_DIR, or null for the main identity (~/.claude). */
  configDir: string | null;
}

export function buildEnv(base: Env, identity: Identity): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  if (identity.configDir) env.CLAUDE_CONFIG_DIR = identity.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  // An inherited value would point the account at another directory's credential (F21).
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  env.XCLAUDE_ACCOUNT = identity.name;
  return env;
}

/** The environment for running claude as an identity (the main identity leaves CLAUDE_CONFIG_DIR unset). */
export function identityEnv(ctx: { env: Env; paths: Paths }, name: string): Record<string, string> {
  return buildEnv(ctx.env, { name, configDir: name === MAIN ? null : accountDir(ctx.paths, name) });
}
