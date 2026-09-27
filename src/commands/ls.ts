// xclaude ls: identities with login status, defaults and config dir.
import { authStatus, describeLogin } from "../claude/auth.ts";
import { findClaude } from "../claude/resolve.ts";
import { type Config, defaultsOf, identities, MAIN } from "../core/config.ts";
import { EXIT_OK, UsageError, XError } from "../core/errors.ts";
import { DASH, formatTable } from "../core/format.ts";
import { accountDir } from "../core/paths.ts";
import { quoteShellWords } from "../core/shellwords.ts";
import type { Ctx } from "../ctx.ts";
import { identityEnv } from "../launch/env.ts";

export async function lsCommand(ctx: Ctx, config: Config, args: string[]): Promise<number> {
  if (args.length) throw new UsageError("usage: xclaude ls");
  const names = identities(config);
  if (!names.length) {
    ctx.io.out("No accounts yet. Add one with: xclaude add <name>\n");
    return EXIT_OK;
  }
  let claude: string | null = null;
  try {
    claude = findClaude(ctx.env, config, ctx.paths.home, ctx.selfPath);
  } catch (e) {
    if (!(e instanceof XError)) throw e;
    ctx.io.err(`xclaude: ${e.message}\n`);
  }
  // All accounts in parallel.
  const logins = await Promise.all(names.map((n) => (claude ? authStatus(claude, identityEnv(ctx, n)).then(describeLogin) : "?")));
  const rows = names.map((n, i) => {
    const d = defaultsOf(config, n)!;
    // The exact CLAUDE_CONFIG_DIR string, ready to copy into an editor's settings.
    const dir = n === MAIN ? `${ctx.paths.store} (no CLAUDE_CONFIG_DIR)` : accountDir(ctx.paths, n);
    return [n, logins[i]!, d.model ?? DASH, d.effort ?? DASH, d.args.length ? quoteShellWords(d.args) : DASH, dir];
  });
  ctx.io.out(formatTable(["NAME", "LOGIN", "MODEL", "EFFORT", "ARGS", "CONFIG DIR"], rows));
  return EXIT_OK;
}
