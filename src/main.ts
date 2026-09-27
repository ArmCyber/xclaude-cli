// Dispatch: turns the classified argv (grammar.ts) into a command run.
import { addCommand } from "./commands/add.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { guardCommand } from "./commands/guard.ts";
import { helpText, wantsHelp } from "./commands/help.ts";
import { completeCommand, namesCommand } from "./commands/hidden.ts";
import { lsCommand } from "./commands/ls.ts";
import { rmCommand } from "./commands/rm.ts";
import { setCommand } from "./commands/set.ts";
import { shellCommand } from "./commands/shell.ts";
import { accountSessionLabels, tmuxCommand } from "./commands/tmux.ts";
import { COMMANDS, loadConfig } from "./core/config.ts";
import { EXIT_OK, XError } from "./core/errors.ts";
import { tildify } from "./core/paths.ts";
import { loadState, updateState } from "./core/state.ts";
import type { Ctx } from "./ctx.ts";
import { classify } from "./grammar.ts";
import { chooseAccount, launch } from "./launch/launch.ts";
import { refreshInitFiles } from "./shell/init.ts";
import { VERSION } from "./version.ts";

export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const [first] = argv;
  if (first === "-v" || first === "--version") {
    ctx.io.out(`${VERSION}\n`);
    return EXIT_OK;
  }
  if (first === "-h" || first === "--help") {
    ctx.io.out(helpText());
    return EXIT_OK;
  }
  // Help needs no config, so it never creates ~/.xclaude either.
  if (first === "help") {
    ctx.io.out(helpText(wantsHelp(argv.slice(1)) ? "help" : argv[1]));
    return EXIT_OK;
  }
  const tmuxSub = first === "tmux" && ["new", "attach", "ls", "kill"].includes(argv[1] ?? "");
  if (first !== undefined && (COMMANDS as readonly string[]).includes(first) && (wantsHelp(argv.slice(1)) || (tmuxSub && wantsHelp(argv.slice(2))))) {
    ctx.io.out(helpText(first));
    return EXIT_OK;
  }
  if (first === "__complete") return completeCommand(ctx, argv.slice(1));
  if (first === "__names") return namesCommand(ctx);
  // doctor reports a broken config instead of failing on it, so it loads the config itself.
  if (first === "doctor") return doctorCommand(ctx, argv.slice(1));

  const { config, created } = loadConfig(ctx.paths, { create: true });
  if (created && first !== "add" && first !== "shell") {
    const where = tildify(ctx.paths.xhome, ctx.paths.home);
    ctx.io.err(
      `xclaude: created ${where}. Next: \`xclaude add <name>\` to add an account, then \`xclaude shell install\` for completion.\n`,
    );
  }

  // The first run after an update regenerates the shell integration.
  try {
    if (loadState(ctx.paths).installedVersion !== VERSION) {
      refreshInitFiles(ctx.paths, config, VERSION);
      updateState(ctx.paths, (s) => {
        s.installedVersion = VERSION;
      });
    }
  } catch {
    // best-effort: never block a command on it
  }

  const action = classify(argv, config);
  switch (action.kind) {
    case "version":
    case "help":
      return EXIT_OK; // handled above
    case "command":
      switch (action.name) {
        case "add":
          return addCommand(ctx, config, action.args);
        case "set":
          return setCommand(ctx, config, action.args);
        case "ls":
          return lsCommand(ctx, config, action.args);
        case "rm":
          return rmCommand(ctx, config, action.args, (account) => accountSessionLabels(ctx, account));
        case "tmux":
          return tmuxCommand(ctx, config, action.args);
        case "shell":
          return shellCommand(ctx, config, action.args);
        case "guard":
          return guardCommand(ctx, config, action.args);
        default:
          // help and doctor are answered before the config loads.
          throw new XError(`${action.name}: unexpected here`);
      }
    case "hidden":
      return EXIT_OK; // handled above
    case "launch":
      return launch(ctx, config, action.account ?? (await chooseAccount(ctx, config)), action.args);
  }
}
