// Hidden commands used by the shell integration. They never create files and
// never fail loudly: a broken config just means no output.
import { type Config, identities, loadConfig } from "../core/config.ts";
import { EXIT_OK } from "../core/errors.ts";
import type { Ctx } from "../ctx.ts";
import { complete, formatCompletion, type ShellName } from "../shell/complete.ts";

function quietConfig(ctx: Ctx): Config | null {
  try {
    return loadConfig(ctx.paths, { create: false }).config;
  } catch {
    return null;
  }
}

/** xclaude __complete <bash|zsh> <cword> <words…> */
export function completeCommand(ctx: Ctx, args: string[]): number {
  const [shell, cwordArg, ...words] = args;
  const cword = Number(cwordArg);
  if ((shell !== "bash" && shell !== "zsh") || !Number.isInteger(cword) || cword < 0) return EXIT_OK;
  const config = quietConfig(ctx);
  if (!config) return EXIT_OK;
  try {
    const { completion, cur } = complete(ctx, config, shell as ShellName, cword, words);
    ctx.io.out(formatCompletion(completion, shell as ShellName, cur));
  } catch {
    // best-effort
  }
  return EXIT_OK;
}

/** xclaude __names: the enabled identities, for the guard's message. */
export function namesCommand(ctx: Ctx): number {
  const config = quietConfig(ctx);
  const names = config ? identities(config) : [];
  if (names.length) ctx.io.out(`${names.join(" ")}\n`);
  return EXIT_OK;
}
