// xclaude add <name> [--model M] [--effort E] [--args "…"]
import fs from "node:fs";
import { authStatus, describeLogin } from "../claude/auth.ts";
import { findClaude } from "../claude/resolve.ts";
import { accountNameProblem, type Config, type Defaults, identities, loadConfig, saveConfig } from "../core/config.ts";
import { EXIT_OK, UsageError, XError } from "../core/errors.ts";
import { parseOptions } from "../core/options.ts";
import { accountDir, mkdirPrivate, tildify } from "../core/paths.ts";
import type { Ctx } from "../ctx.ts";
import { identityEnv } from "../launch/env.ts";
import { runChild } from "../launch/exec.ts";
import { problemLine, repairAccount, unmanageable } from "../link/repair.ts";
import { shareTable } from "../link/table.ts";
import { applyDefaultOptions, DEFAULT_OPTIONS } from "./defaults.ts";

const USAGE = 'usage: xclaude add <name> [--model M] [--effort E] [--args "…"]';

export async function addCommand(ctx: Ctx, config: Config, args: string[]): Promise<number> {
  const p = parseOptions(args, DEFAULT_OPTIONS, "add");
  const [name, ...extra] = p.positionals;
  if (!name || extra.length) throw new UsageError(USAGE);
  const problem = accountNameProblem(name);
  if (problem) throw new UsageError(problem);
  if (Object.hasOwn(config.accounts, name)) throw new XError(`account "${name}" already exists; change its defaults with: xclaude set ${name}`);
  const defaults: Defaults = { model: null, effort: null, args: [] };
  applyDefaultOptions(p, ctx.paths.home, defaults);
  // Before creating anything: without Claude Code there's nothing to log in with.
  const claude = findClaude(ctx.env, config, ctx.paths.home, ctx.selfPath);

  const log = (line: string) => ctx.io.err(`${line}\n`);
  const dir = accountDir(ctx.paths, name);
  const refusal = unmanageable(dir, ctx.paths.store);
  if (refusal) throw new XError(`not adding ${name}: ${tildify(dir, ctx.paths.home)} ${refusal}. Replace it with a real folder, or remove it, then add ${name} again.`);
  if (fs.existsSync(dir)) log(`xclaude: ${tildify(dir, ctx.paths.home)} already exists; reusing it`);
  mkdirPrivate(dir);
  const res = repairAccount({
    paths: ctx.paths,
    account: name,
    table: shareTable(config, ctx.switches),
    lockWaitMs: Infinity,
    replaceWrongLinks: false,
    log,
  });
  for (const pr of res.problems) log(`xclaude: ${problemLine(name, pr)}`);
  // Reload: another xclaude may have changed the config while this one waited for the repair.
  config = loadConfig(ctx.paths, { create: false }).config;
  config.accounts[name] = defaults;
  saveConfig(ctx.paths, config);

  log(`xclaude: added ${name}. Starting Claude Code in it: go through the first-run screens, log in with /login, then quit.`);
  const env = identityEnv(ctx, name);
  await runChild(claude, [], env);

  const status = await authStatus(claude, env);
  if (!status.loggedIn) {
    log(`xclaude: ${name} isn't logged in yet. Log in later with \`xclaude ${name} auth login\`, or /login inside \`xclaude ${name}\`.`);
    return EXIT_OK;
  }
  log(`xclaude: ${name} is logged in as ${describeLogin(status)}. Launch it with: xclaude ${name}`);

  // The same login as another identity is almost always a mistake.
  const others = identities(config).filter((n) => n !== name);
  const theirs = await Promise.all(others.map((n) => authStatus(claude, identityEnv(ctx, n))));
  others.forEach((other, i) => {
    const s = theirs[i]!;
    if (s.loggedIn && s.email === status.email && s.orgId === status.orgId) {
      log(`xclaude: warning: ${name} and ${other} use the same login (${describeLogin(status)})`);
    }
  });
  return EXIT_OK;
}
