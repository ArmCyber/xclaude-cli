// xclaude guard on|off|status
import { type Config, saveConfig } from "../core/config.ts";
import { EXIT_OK, UsageError } from "../core/errors.ts";
import { tildify } from "../core/paths.ts";
import type { Ctx } from "../ctx.ts";
import { writeInitFiles } from "../shell/init.ts";
import { installedIn } from "../shell/rc.ts";
import { VERSION } from "../version.ts";

export function guardCommand(ctx: Ctx, config: Config, args: string[]): number {
  const [sub = "status", ...rest] = args;
  if (rest.length || !["on", "off", "status"].includes(sub)) throw new UsageError("usage: xclaude guard on|off|status");
  const rcFiles = installedIn(ctx.env, ctx.paths.home).map((f) => tildify(f, ctx.paths.home));
  if (sub === "status") {
    ctx.io.out(`guard: ${config.guard ? "on" : "off"}\n`);
    ctx.io.out(`shell integration: ${rcFiles.length ? `installed in ${rcFiles.join(", ")}` : "not installed (xclaude shell install)"}\n`);
    return EXIT_OK;
  }
  config.guard = sub === "on";
  saveConfig(ctx.paths, config);
  writeInitFiles(ctx.paths, config, VERSION);
  ctx.io.err(
    `xclaude: guard ${sub}: bare \`claude\` ${config.guard ? "refuses to run" : "works again"} in new shells (or after: exec $SHELL)\n`,
  );
  if (!rcFiles.length) ctx.io.err("xclaude: the shell block isn't installed yet, so this has no effect until you run: xclaude shell install\n");
  return EXIT_OK;
}
