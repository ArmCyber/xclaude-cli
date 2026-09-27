// The claude argument list.
import type { Defaults } from "../core/config.ts";
import { findOption, type HelpInfo, isSubcommand, longName } from "../claude/help.ts";

/** True when the user already passed the flag, as `--x v` or `--x=v` (before any `--`). */
export function hasFlag(args: string[], flag: string): boolean {
  for (const a of args) {
    if (a === "--") return false;
    if (a === flag || a.startsWith(`${flag}=`)) return true;
  }
  return false;
}

/**
 * Account args with every value-taking flag written as `--flag=value`, one per
 * value. With a space-separated variadic flag such as `--add-dir <dirs...>`,
 * Claude Code's parser would take a following prompt as one more value; the `=`
 * form never swallows the next argument. Unknown flags are passed as written.
 */
export function normalizeAccountArgs(args: string[], help: HelpInfo): string[] {
  const { args: out, bare } = splitAccountArgs(args, help);
  return [...out, ...bare.map((b) => b.flag)];
}

export interface BareFlag {
  /** The flag as emitted. */
  flag: string;
  /** Every spelling, to spot the user typing it. */
  names: string[];
}

/**
 * Account args with value-taking flags as --flag=value, and apart from them
 * the flags that take an optional value but were given none (--remote-control,
 * --worktree…): wherever they stand, the next word would become their value.
 */
export function splitAccountArgs(args: string[], help: HelpInfo): { args: string[]; bare: BareFlag[] } {
  const out: string[] = [];
  const bare: BareFlag[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i));
      break;
    }
    const spec = a.startsWith("-") && a !== "-" && !a.includes("=") ? findOption(help, a) : undefined;
    if (!spec) {
      out.push(a);
      continue;
    }
    const flag = longName(spec);
    const next = args[i + 1];
    switch (spec.value) {
      case "none":
        out.push(a);
        break;
      case "required":
        if (next === undefined) out.push(a);
        else {
          out.push(`${flag}=${next}`);
          i++;
        }
        break;
      case "optional":
        if (next === undefined || next.startsWith("-")) bare.push({ flag, names: spec.names });
        else {
          out.push(`${flag}=${next}`);
          i++;
        }
        break;
      case "variadic": {
        let n = 0;
        while (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
          out.push(`${flag}=${args[++i]}`);
          n++;
        }
        if (!n) out.push(a);
        break;
      }
    }
  }
  return { args: out, bare };
}

/**
 * If the first user argument is a Claude Code subcommand, the user arguments
 * pass through unchanged. Otherwise: [account args…] [--model M] [--effort E]
 * [user args…]. --model and --effort are added only when set and not already
 * typed; user arguments come last, so they win (invariant 8).
 */
export function buildArgs(defaults: Defaults, userArgs: string[], help: HelpInfo | null): string[] {
  if (isSubcommand(userArgs[0], help)) return [...userArgs];
  const { args: out, bare } = defaults.args.length && help ? splitAccountArgs(defaults.args, help) : { args: [...defaults.args], bare: [] };
  if (defaults.model && !hasFlag(userArgs, "--model")) out.push("--model", defaults.model);
  if (defaults.effort && !hasFlag(userArgs, "--effort")) out.push("--effort", defaults.effort);
  // A bare optional-value flag goes last (before any `--`), so it can't take the
  // user's prompt as its value; if the user typed that flag, theirs wins.
  const user = [...userArgs];
  const extra = bare.filter((b) => !b.names.some((n) => hasFlag(userArgs, n))).map((b) => b.flag);
  const dashdash = user.indexOf("--");
  if (dashdash >= 0) user.splice(dashdash, 0, ...extra);
  else user.push(...extra);
  return [...out, ...user];
}

/** Whether building the arguments needs the parsed help (reading the cache costs a file read). */
export function needsHelp(defaults: Defaults, userArgs: string[]): boolean {
  const first = userArgs[0];
  return defaults.args.length > 0 || (first !== undefined && !first.startsWith("-"));
}
