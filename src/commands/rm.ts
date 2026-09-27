// xclaude rm <name> [--keep-login] [-y] and xclaude rm --leftovers [-y]
import { authStatus, runClaude } from "../claude/auth.ts";
import { findClaude } from "../claude/resolve.ts";
import { type Config, identities, loadConfig, MAIN, saveConfig } from "../core/config.ts";
import { Cancelled, EXIT_ERROR, EXIT_OK, UsageError, XError } from "../core/errors.ts";
import { lstatOrNull, removeTree } from "../core/fsutil.ts";
import { parseOptions } from "../core/options.ts";
import { accountDir, tildify } from "../core/paths.ts";
import { confirm } from "../core/prompt.ts";
import { forgetAccount, updateState } from "../core/state.ts";
import type { Ctx } from "../ctx.ts";
import { unknownAccount } from "../grammar.ts";
import { identityEnv } from "../launch/env.ts";
import { type Folder, keepOnlyLinks, leftoverNames, strayFolders } from "../link/leftover.ts";
import { normalizePaths } from "../link/normalize.ts";
import { problemLine, repairAccount } from "../link/repair.ts";
import { shareTable } from "../link/table.ts";

const USAGE = "usage: xclaude rm <name> [--keep-login] [-y], or xclaude rm --leftovers [-y]";

/** Lists the tmux sessions still using an account (filled in by the tmux module). */
export type SessionLister = (account: string) => string[];

export async function rmCommand(ctx: Ctx, config: Config, args: string[], listSessions: SessionLister = () => []): Promise<number> {
  const p = parseOptions(args, { "keep-login": {}, leftovers: {}, yes: { short: "y" } }, "rm");
  const [name, ...extra] = p.positionals;
  const yes = Boolean(p.values.yes);
  if (p.values.leftovers) {
    if (name) throw new UsageError(USAGE);
    return removeLeftovers(ctx, config, null, yes, listSessions);
  }
  if (!name || extra.length) throw new UsageError(USAGE);
  if (name === MAIN) throw new UsageError("the main identity isn't removable; turn it off with: xclaude set main --disable");
  if (!Object.hasOwn(config.accounts, name)) {
    if (strayFolders(ctx.paths, config).some((f) => f.name === name)) return removeLeftovers(ctx, config, name, yes, listSessions);
    throw unknownAccount(name, config);
  }
  const log = (line: string) => ctx.io.err(`${line}\n`);
  const dir = accountDir(ctx.paths, name);
  const st = lstatOrNull(dir);
  if (st?.isSymbolicLink()) {
    throw new XError(`not removing ${name}: ${tildify(dir, ctx.paths.home)} is a symlink, and xclaude only manages real folders there. Replace it with a real folder, or remove it by hand.`);
  }

  if (!yes) {
    if (!ctx.tty.stdin) throw new UsageError(`removing ${name} needs a confirmation: run it in a terminal, or pass -y`);
    const ok = confirm(`Remove account ${name}? Its login and settings go; shared conversations and content stay in ~/.claude.`);
    if (!ok) {
      log("xclaude: nothing removed");
      throw new Cancelled();
    }
  }

  if (!st) {
    // Nothing to log out or keep, and a repair would only create the folder again.
    forget(ctx, name);
    log(`xclaude: removed ${name}; its folder was already gone, so it wasn't logged out (on macOS its Keychain login may remain)`);
    return EXIT_OK;
  }

  // Deleting a real directory where a link belongs would delete shared data, so
  // everything must be a correct link first.
  const table = shareTable(config, ctx.switches);
  const res = repairAccount({ paths: ctx.paths, account: name, table, lockWaitMs: Infinity, replaceWrongLinks: false, log });
  if (!res.clean) {
    for (const pr of res.problems) log(`xclaude: ${problemLine(name, pr)}`);
    throw new XError(`not removing ${name}: its links aren't all in place, and deleting now could delete shared data. Run \`xclaude doctor --fix\` first.`);
  }
  if (ctx.switches.normalizePaths && table.dirs.includes("plugins")) {
    normalizePaths(ctx.paths, { account: name, lockWaitMs: Infinity, log });
  }

  let claude: string | null = null;
  try {
    claude = findClaude(ctx.env, config, ctx.paths.home, ctx.selfPath);
  } catch (e) {
    if (!(e instanceof XError)) throw e;
    log(`xclaude: ${e.message}; skipping the supervisor stop and the logout`);
  }
  if (claude) {
    const env = identityEnv(ctx, name);
    await runClaude(claude, ["daemon", "stop", "--any"], env);
    await logout(ctx, config, claude, name, Boolean(p.values["keep-login"]), log);
  }

  const sessions = listSessions(name);
  if (sessions.length) log(`xclaude: tmux sessions still running on ${name} (left alone): ${sessions.join(", ")}`);

  // The links stay: paths Claude Code recorded through this folder keep working.
  const { kept, content } = keepOnlyLinks(dir, table);
  removeTree(`${dir}.lock`);
  forget(ctx, name);
  log(`xclaude: removed ${name}`);
  const where = tildify(dir, ctx.paths.home);
  if (content.length) {
    log(
      `xclaude: ${where} keeps its links into ~/.claude, so ${name}'s old conversations can still open their saved long outputs, and ${name}'s own ${content.join(", ")} (not shared). Move what you want to keep; then \`xclaude rm ${name}\` deletes the rest.`,
    );
  } else if (kept) {
    log(`xclaude: ${where} keeps only its links into ~/.claude, so ${name}'s old conversations can still open their saved long outputs; delete it with: xclaude rm ${name}`);
  }
  return EXIT_OK;
}

/** Drops an account from the config (reloaded: another xclaude may have changed it meanwhile) and the state. */
function forget(ctx: Ctx, name: string): void {
  const fresh = loadConfig(ctx.paths, { create: false }).config;
  delete fresh.accounts[name];
  saveConfig(ctx.paths, fresh);
  updateState(ctx.paths, (s) => forgetAccount(s, name));
}

/** Why a folder in accounts/ isn't deleted. */
function whyNot(f: Folder, where: string): string {
  switch (f.kind) {
    case "content":
      return `not deleting ${where}: it holds more than links (${f.entries.join(", ")}). \`xclaude add ${f.name}\` takes it back as an account, merging shared content into ~/.claude; or check it and delete it by hand.`;
    case "stray":
      return `not deleting ${where}: that name couldn't be an account's, so xclaude didn't make this folder; check it by hand.`;
    case "link":
      return `not deleting ${where}: it's a symlink, and xclaude only manages real folders there.`;
    default:
      return "";
  }
}

/**
 * Deletes the leftover folders of removed accounts (or just `only`), after one
 * confirmation. Only a folder holding nothing but links is deleted; anything else is
 * left alone with the reason. A leftover whose account still has tmux sessions is kept,
 * since deleting its links would make those sessions write elsewhere.
 */
function removeLeftovers(ctx: Ctx, config: Config, only: string | null, yes: boolean, listSessions: SessionLister): number {
  const log = (line: string) => ctx.io.err(`${line}\n`);
  const where = (name: string) => tildify(accountDir(ctx.paths, name), ctx.paths.home);
  const folders = strayFolders(ctx.paths, config).filter((f) => only === null || f.name === only);
  if (!folders.length) {
    log("xclaude: no leftover folders");
    return EXIT_OK;
  }
  const names: string[] = [];
  for (const f of folders) {
    const sessions = f.kind === "leftover" ? listSessions(f.name) : [];
    if (f.kind !== "leftover") log(`xclaude: ${whyNot(f, where(f.name))}`);
    else if (sessions.length) log(`xclaude: not deleting ${where(f.name)}: tmux sessions of ${f.name} still run (${sessions.join(", ")}); end them first`);
    else names.push(f.name);
  }
  if (!names.length) return EXIT_ERROR;
  if (!yes) {
    if (!ctx.tty.stdin) throw new UsageError("deleting leftover folders needs a confirmation: run it in a terminal, or pass -y");
    const which = names.length === 1 ? `${names[0]}'s leftover folder` : `the leftover folders of ${names.join(", ")}`;
    const ok = confirm(`Delete ${which}? Old conversations from ${names.length === 1 ? "it" : "them"} can then no longer open their saved long outputs.`);
    if (!ok) {
      log("xclaude: nothing deleted");
      throw new Cancelled();
    }
  }
  // Checked again after the question: an `add` may have taken a folder back meanwhile.
  const still = new Set(leftoverNames(ctx.paths, loadConfig(ctx.paths, { create: false }).config));
  let deleted = 0;
  for (const name of names) {
    if (!still.has(name)) {
      log(`xclaude: left ${where(name)} alone: it changed meanwhile`);
      continue;
    }
    const dir = accountDir(ctx.paths, name);
    removeTree(dir);
    removeTree(`${dir}.lock`);
    log(`xclaude: deleted ${where(name)}`);
    deleted++;
  }
  return deleted === folders.length ? EXIT_OK : EXIT_ERROR;
}

/**
 * Logs the account out so its login (on macOS, its Keychain entry) doesn't
 * linger for a later `add` with the same name (F21). Skipped with --keep-login.
 * Spike 14 showed a logout leaves other logins of the same user alone; the
 * keepSameEmailLogin switch brings back the old caution (skip when another
 * identity has the same email, or can't be read).
 */
async function logout(ctx: Ctx, config: Config, claude: string, name: string, keep: boolean, log: (l: string) => void): Promise<void> {
  if (keep) {
    log(`xclaude: keeping ${name}'s login (--keep-login)`);
    return;
  }
  // Every other login that could be the same user, including the one in ~/.claude
  // (plain claude and editors use it) even while the main identity is off.
  const others = ctx.switches.keepSameEmailLogin
    ? identities(config)
        .filter((n) => n !== name)
        .map((n) => ({ label: n, env: identityEnv(ctx, n) }))
    : [];
  if (ctx.switches.keepSameEmailLogin && !config.main.enabled) others.push({ label: "the ~/.claude login", env: identityEnv(ctx, MAIN) });
  const [mine, ...theirs] = await Promise.all([identityEnv(ctx, name), ...others.map((o) => o.env)].map((env) => authStatus(claude, env)));
  if (mine!.error) {
    log(`xclaude: couldn't read ${name}'s login (${mine!.error}), so it isn't logged out; its login may remain (on macOS, in the Keychain)`);
    return;
  }
  if (!mine!.loggedIn) return;
  if (ctx.switches.keepSameEmailLogin) {
    const unknown = others.filter((_, i) => theirs[i]!.error);
    if (unknown.length) {
      log(`xclaude: not logging ${name} out: couldn't read the login of ${unknown.map((o) => o.label).join(", ")}, which may use the same email`);
      return;
    }
    const same = others.filter((_, i) => theirs[i]!.loggedIn && theirs[i]!.email === mine!.email);
    if (same.length) {
      log(`xclaude: not logging ${name} out: ${same.map((o) => o.label).join(", ")} ${same.length > 1 ? "are" : "is"} logged in with the same email (${mine!.email}), and a logout could affect ${same.length > 1 ? "them" : "it"}`);
      return;
    }
  }
  const res = await runClaude(claude, ["auth", "logout"], identityEnv(ctx, name));
  if (res.code !== 0) log(`xclaude: logging ${name} out failed: ${(res.stderr || res.stdout).trim().split("\n")[0]}`);
}
