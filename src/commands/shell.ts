// xclaude shell install|uninstall [--bash] [--zsh], xclaude shell completion bash|zsh
import type { Config } from "../core/config.ts";
import { EXIT_OK, UsageError, XError } from "../core/errors.ts";
import { readFileOrNull, removeTree } from "../core/fsutil.ts";
import { parseOptions } from "../core/options.ts";
import { tildify } from "../core/paths.ts";
import type { Ctx } from "../ctx.ts";
import { initBash, initFile, initZsh, writeInitFiles } from "../shell/init.ts";
import { blockFor, knownRcFiles, type RcTarget, rcTargets, removeBlock, upsertBlock, writeRc } from "../shell/rc.ts";
import { VERSION } from "../version.ts";

function install(ctx: Ctx, config: Config, args: string[]): number {
  const p = parseOptions(args, { bash: {}, zsh: {} }, "shell install");
  if (p.positionals.length) throw new UsageError("usage: xclaude shell install [--bash] [--zsh]");
  const targets = rcTargets(ctx.env, ctx.paths.home, process.platform, { bash: Boolean(p.values.bash), zsh: Boolean(p.values.zsh) });
  if (!targets.length) throw new XError("neither ~/.zshrc nor ~/.bashrc exists; pick one with --zsh or --bash (it gets created)");
  writeInitFiles(ctx.paths, config, VERSION);
  for (const t of targets) {
    const label = tildify(t.file, ctx.paths.home);
    const previous = readFileOrNull(t.file);
    const text = upsertBlock(previous ?? "", blockFor(initFile(ctx.paths, t.shell)), label);
    const res = writeRc(t.file, text, previous);
    if (res.status === "written") ctx.io.err(`xclaude: ${previous === null ? "created" : "updated"} ${label}\n`);
    else if (res.status === "unchanged") ctx.io.err(`xclaude: ${label} is already set up\n`);
    else {
      ctx.io.err(`xclaude: ${label} isn't writable (read-only, or managed elsewhere); add this block to it by hand:\n`);
      ctx.io.out(blockFor(initFile(ctx.paths, t.shell)));
    }
  }
  ctx.io.err("Open a new shell (or run: exec $SHELL) to use it.\n");
  return EXIT_OK;
}

function uninstall(ctx: Ctx, args: string[]): number {
  const p = parseOptions(args, { bash: {}, zsh: {} }, "shell uninstall");
  if (p.positionals.length) throw new UsageError("usage: xclaude shell uninstall [--bash] [--zsh]");
  const only = p.values.bash || p.values.zsh ? { bash: Boolean(p.values.bash), zsh: Boolean(p.values.zsh) } : null;
  const targets: RcTarget[] = knownRcFiles(ctx.env, ctx.paths.home).filter((t) => !only || only[t.shell]);
  let count = 0;
  for (const t of targets) {
    const label = tildify(t.file, ctx.paths.home);
    const previous = readFileOrNull(t.file);
    if (previous === null) continue;
    const { text, found } = removeBlock(previous, label);
    if (!found) continue;
    count++;
    const res = writeRc(t.file, text, previous);
    if (res.status === "manual") ctx.io.err(`xclaude: ${label} isn't writable; remove the xclaude block from it by hand\n`);
    else ctx.io.err(`xclaude: removed the block from ${label}\n`);
  }
  if (!only) removeTree(ctx.paths.shell);
  if (!count) ctx.io.err("xclaude: no shell block was installed\n");
  return EXIT_OK;
}

export function shellCommand(ctx: Ctx, config: Config, args: string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "install":
      return install(ctx, config, rest);
    case "uninstall":
      return uninstall(ctx, rest);
    case "completion": {
      if (rest.length !== 1 || (rest[0] !== "bash" && rest[0] !== "zsh")) throw new UsageError("usage: xclaude shell completion bash|zsh");
      ctx.io.out(rest[0] === "bash" ? initBash(VERSION, false) : initZsh(VERSION, false));
      return EXIT_OK;
    }
    default:
      throw new UsageError("usage: xclaude shell install|uninstall [--bash] [--zsh], or xclaude shell completion bash|zsh");
  }
}
