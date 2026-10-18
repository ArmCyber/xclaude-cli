// xclaude set <name> [--model M] [--effort E] [--args "…"] [--unset model|effort|args] [--inherit on|off|reset]
// xclaude set main --enable|--disable
import { type Config, type Defaults, MAIN, saveConfig } from "../core/config.ts";
import { EXIT_OK, UsageError } from "../core/errors.ts";
import { parseOptions, stringOption } from "../core/options.ts";
import type { Ctx } from "../ctx.ts";
import { unknownAccount } from "../grammar.ts";
import { inheritSettings, resetInherit, stopInheriting } from "../link/inherit.ts";
import { applyDefaultOptions, DEFAULT_OPTIONS, formatDefaults } from "./defaults.ts";

const USAGE =
  'usage: xclaude set <name> [--model M] [--effort E] [--args "…"] [--unset model|effort|args] [--inherit on|off|reset], or xclaude set main --enable|--disable';
const KEYS = ["model", "effort", "args"] as const;
const INHERIT = ["on", "off", "reset"] as const;

export function setCommand(ctx: Ctx, config: Config, args: string[]): number {
  const p = parseOptions(args, { ...DEFAULT_OPTIONS, unset: { value: true, repeat: true }, inherit: { value: true }, enable: {}, disable: {} }, "set");
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
  const inherit = stringOption(p, "inherit");
  if (inherit !== undefined) {
    if (isMain) throw new UsageError("--inherit is for accounts; the main identity is ~/.claude itself");
    if (!(INHERIT as readonly string[]).includes(inherit)) throw new UsageError(`--inherit takes on, off or reset, not "${inherit}"`);
  }

  if (Object.keys(p.values).length) {
    applyDefaultOptions(p, ctx.paths.home, target);
    for (const key of unset) {
      if (key === "args") target.args = [];
      else if (key === "model") target.model = null;
      else target.effort = null;
    }
    if (inherit === "off") target.inherit = false;
    else if (inherit !== undefined) delete target.inherit;
    if (p.values.enable) config.main.enabled = true;
    if (p.values.disable) config.main.enabled = false;
    saveConfig(ctx.paths, config);
  }
  if (inherit !== undefined) applyInherit(ctx, name, inherit);

  let head = name;
  if (isMain) head += config.main.enabled ? " (enabled: the login in ~/.claude)" : " (disabled; enable with: xclaude set main --enable)";
  ctx.io.out(`${head}\n${formatDefaults(target, !isMain)}`);
  return EXIT_OK;
}

/** Brings the account's settings.json in line with --inherit now, rather than at its next launch. */
function applyInherit(ctx: Ctx, name: string, inherit: string): void {
  const log = (line: string) => ctx.io.err(`${line}\n`);
  const opts = { lockWaitMs: Infinity, log };
  if (inherit === "off") {
    if (!stopInheriting(ctx.paths, name, opts)) {
      log(`xclaude: Claude Code wrote ${name}'s settings.json meanwhile, so what it took from ~/.claude/settings.json is still there; run this again`);
    }
  } else if (inherit === "reset") resetInherit(ctx.paths, name, opts);
  else inheritSettings(ctx.paths, name, opts);
}
