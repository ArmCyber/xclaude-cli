// The launch pipeline: `xclaude <account> [args…]`.
import { type HelpInfo, isSubcommand, loadHelp } from "../claude/help.ts";
import { findClaude } from "../claude/resolve.ts";
import { type Config, type Defaults, defaultsOf, describeDefaults, identities, inherits, MAIN } from "../core/config.ts";
import { UsageError, XError } from "../core/errors.ts";
import { accountDir, tildify } from "../core/paths.ts";
import { loadState, recordUse, updateState } from "../core/state.ts";
import type { Ctx } from "../ctx.ts";
import { unknownAccount } from "../grammar.ts";
import { inheritSettings } from "../link/inherit.ts";
import { prepareMcp } from "../link/mcp.ts";
import { normalizePaths } from "../link/normalize.ts";
import { listPlugins } from "../link/plugins.ts";
import { LAUNCH_LOCK_WAIT_MS, problemLine, repairAccount } from "../link/repair.ts";
import { shareTable } from "../link/table.ts";
import { takeNewUnknown, unknownEntries, unknownNotice } from "../link/unknown.ts";
import { buildArgs, hasFlag, needsHelp } from "./args.ts";
import { buildEnv, sharedMemoryDir, takeCredentialNotes } from "./env.ts";
import { settleInherit } from "./inherit-question.ts";
import { pick, preselect } from "./picker.ts";

/** The picker's entries: each enabled identity with its defaults, e.g. "acme   opus · max". */
export function identityItems(config: Config): Array<{ label: string; detail: string }> {
  return identities(config).map((name) => {
    const d = defaultsOf(config, name)!;
    const detail = describeDefaults(d);
    return { label: name, detail: name === MAIN ? ["~/.claude login", detail].filter(Boolean).join(" · ") : detail };
  });
}

/**
 * The account for a launch without one: the picker, when stdin and stderr are
 * terminals.
 */
export async function chooseAccount(ctx: Ctx, config: Config, title = "Launch Claude Code as"): Promise<string> {
  const names = identities(config);
  if (!names.length) throw new XError("no accounts yet; add one with: xclaude add <name>");
  if (!ctx.tty.stdin || !ctx.tty.stderr) throw new UsageError(`account required: xclaude <account> [claude args…] (accounts: ${names.join(", ")})`);
  const index = await pick(title, identityItems(config), preselect(names, loadState(ctx.paths), ctx.cwd));
  return names[index]!;
}

/**
 * Brings a regular account's links in line before a launch. Never waits more
 * than 2 s for the store lock; problems are reported, not fatal.
 */
export function prepareAccount(ctx: Ctx, config: Config, account: string): string[] {
  const log = (line: string) => ctx.io.err(`${line}\n`);
  try {
    return repairForLaunch(ctx, config, account, log);
  } catch (e) {
    log(`xclaude: couldn't check ${account}'s links (${(e as Error).message}); launching anyway`);
    return [];
  }
}

function repairForLaunch(ctx: Ctx, config: Config, account: string, log: (line: string) => void): string[] {
  const table = shareTable(config, ctx.switches);
  const res = repairAccount({
    paths: ctx.paths,
    account,
    table,
    lockWaitMs: LAUNCH_LOCK_WAIT_MS,
    replaceWrongLinks: false,
    log,
  });
  if (res.busy) log("xclaude: links not checked this time: another xclaude is repairing; the next launch retries");
  for (const p of res.problems) log(`xclaude: ${problemLine(account, p)}`);
  if (ctx.switches.normalizePaths && table.dirs.includes("plugins")) {
    normalizePaths(ctx.paths, { lockWaitMs: LAUNCH_LOCK_WAIT_MS, log });
  }
  // A busy store lock already cost this launch its wait; the next launch catches up.
  if (inherits(config, account) && !res.busy) inheritSettings(ctx.paths, account, { lockWaitMs: LAUNCH_LOCK_WAIT_MS, log });
  if (table.dirs.includes("plugins") && !res.busy) {
    listPlugins(ctx.paths, account, { lockWaitMs: LAUNCH_LOCK_WAIT_MS, log, follow: inherits(config, account) });
  }
  return unknownEntries(res.names, table);
}

/**
 * The --mcp-config file with the ~/.claude login's MCP servers, for a session of
 * an account that takes them. Not for subcommands, nor for a session started with
 * --strict-mcp-config, which asks for only the servers it's given.
 */
function mcpForLaunch(ctx: Ctx, config: Config, account: string, defaults: Defaults, userArgs: string[], help: HelpInfo | null): string | null {
  if (!inherits(config, account) || isSubcommand(userArgs[0], help)) return null;
  if (hasFlag(userArgs, "--strict-mcp-config") || hasFlag(defaults.args, "--strict-mcp-config")) return null;
  try {
    return prepareMcp(ctx.paths, account);
  } catch (e) {
    ctx.io.err(`xclaude: couldn't pass ~/.claude.json's MCP servers to ${account} (${(e as Error).message}); launching without them\n`);
    return null;
  }
}

export async function launch(ctx: Ctx, config: Config, account: string, userArgs: string[]): Promise<number> {
  // 1. Resolve the account (the grammar and the picker only pass known ones).
  const defaults = defaultsOf(config, account);
  if (!defaults) throw unknownAccount(account, config);
  const isMain = account === MAIN;

  // 2. The link engine, for regular accounts only, once the account has said
  //    whether it takes ~/.claude's setup (its first launch in a terminal asks).
  const settled = isMain ? config : await settleInherit(ctx, config, account);
  const unknown = isMain ? [] : prepareAccount(ctx, settled, account);

  // 5 before 3: the arguments may need the binary's parsed --help.
  const claude = findClaude(ctx.env, config, ctx.paths.home, ctx.selfPath);
  // 3. Arguments.
  const help = needsHelp(defaults, userArgs) ? loadHelp(claude, ctx.paths.cache, ctx.env) : null;
  const mcp = isMain ? null : mcpForLaunch(ctx, settled, account, defaults, userArgs, help);
  const args = [...(mcp ? [`--mcp-config=${mcp}`] : []), ...buildArgs(defaults, userArgs, help)];
  // 4. Environment.
  const memoryDir = sharedMemoryDir(ctx.paths, shareTable(settled, ctx.switches), ctx.switches);
  const env = buildEnv(ctx.env, { name: account, configDir: isMain ? null : accountDir(ctx.paths, account), memoryDir });

  // 6. Remember the account for this directory, and what was said about unknown entries and credentials.
  try {
    updateState(ctx.paths, (state) => {
      recordUse(state, ctx.cwd, account);
      const configLabel = tildify(ctx.paths.config, ctx.paths.home);
      for (const entry of takeNewUnknown(state, account, unknown)) ctx.io.err(`${unknownNotice(account, entry, configLabel)}\n`);
      if (!isMain) for (const line of takeCredentialNotes(state, account, ctx.env)) ctx.io.err(`${line}\n`);
    });
  } catch {
    // The state is a convenience; never block a launch on it.
  }

  // 7. Replace the process.
  return ctx.exec(claude, [claude, ...args], env);
}
