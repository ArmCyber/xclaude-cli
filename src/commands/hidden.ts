// Hidden commands: two for the shell integration, and the update check's
// background half. They never fail loudly: a broken config just means no output.
import { type Config, identities, loadConfig } from "../core/config.ts";
import { EXIT_OK } from "../core/errors.ts";
import type { Ctx } from "../ctx.ts";
import { complete, formatCompletion, type ShellName } from "../shell/complete.ts";
import { REGISTRY_URL, runUpdateCheck } from "../update.ts";

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

/** xclaude __update-check: asks npm for the latest version (started in the background by update.ts). */
export async function updateCheckCommand(ctx: Ctx): Promise<number> {
  await runUpdateCheck(ctx.paths, ctx.env.XCLAUDE_UPDATE_URL || REGISTRY_URL);
  return EXIT_OK;
}
