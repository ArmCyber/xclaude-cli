// xclaude set <name> [--model M] [--effort E] [--args "…"] [--unset model|effort|args]
// xclaude set main --enable|--disable
import { type Config, type Defaults, MAIN, saveConfig } from "../core/config.ts";
import { EXIT_OK, UsageError } from "../core/errors.ts";
import { parseOptions } from "../core/options.ts";
import type { Ctx } from "../ctx.ts";
import { unknownAccount } from "../grammar.ts";
import { applyDefaultOptions, DEFAULT_OPTIONS, formatDefaults } from "./defaults.ts";

const USAGE = 'usage: xclaude set <name> [--model M] [--effort E] [--args "…"] [--unset model|effort|args], or xclaude set main --enable|--disable';
const KEYS = ["model", "effort", "args"] as const;

export function setCommand(ctx: Ctx, config: Config, args: string[]): number {
  const p = parseOptions(args, { ...DEFAULT_OPTIONS, unset: { value: true, repeat: true }, enable: {}, disable: {} }, "set");
  const [name, ...extra] = p.positionals;
  if (!name || extra.length) throw new UsageError(USAGE);
  const isMain = name === MAIN;
  if (!isMain && !Object.hasOwn(config.accounts, name)) throw unknownAccount(name, config);
  const target: Defaults = isMain ? config.main : config.accounts[name]!;

  if ((p.values.enable || p.values.disable) && !isMain) {
    throw new UsageError("--enable and --disable are for the main identity: xclaude set main --enable");
  }
  if (p.values.enable && p.values.disable) throw new UsageError("choose --enable or --disable");
  const unset = (p.values.unset as string[] | undefined) ?? [];
  for (const key of unset) {
    if (!(KEYS as readonly string[]).includes(key)) throw new UsageError(`--unset takes model, effort or args, not "${key}"`);
    if (p.values[key] !== undefined) throw new UsageError(`--${key} and --unset ${key} contradict each other`);
  }

  if (Object.keys(p.values).length) {
    applyDefaultOptions(p, ctx.paths.home, target);
    for (const key of unset) {
      if (key === "args") target.args = [];
      else if (key === "model") target.model = null;
      else target.effort = null;
    }
    if (p.values.enable) config.main.enabled = true;
    if (p.values.disable) config.main.enabled = false;
    saveConfig(ctx.paths, config);
  }

  let head = name;
  if (isMain) head += config.main.enabled ? " (enabled: the login in ~/.claude)" : " (disabled; enable with: xclaude set main --enable)";
  ctx.io.out(`${head}\n${formatDefaults(target)}`);
  return EXIT_OK;
}
