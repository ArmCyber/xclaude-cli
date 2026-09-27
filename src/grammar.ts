// The first word decides what happens:
// - a command name runs that command
// - an account name launches that account
// - a word starting with - takes the picker path, except -h/--help and -v/--version
// - anything else is the error "unknown account or command"
import { COMMANDS, type Config, MAIN, identities } from "./core/config.ts";
import { UsageError, XError } from "./core/errors.ts";

export type Command = (typeof COMMANDS)[number];
export const HIDDEN = ["__complete", "__names"] as const;
export type Hidden = (typeof HIDDEN)[number];

export type Action =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "command"; name: Command; args: string[] }
  | { kind: "hidden"; name: Hidden; args: string[] }
  | { kind: "launch"; account: string | null; args: string[] };

export function isCommand(word: string): word is Command {
  return (COMMANDS as readonly string[]).includes(word);
}

export function isHidden(word: string): word is Hidden {
  return (HIDDEN as readonly string[]).includes(word);
}

/** Classifies argv; throws for an unknown first word or a disabled main identity. */
export function classify(argv: string[], config: Config): Action {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "launch", account: null, args: [] };
  if (first === "-v" || first === "--version") return { kind: "version" };
  if (first === "-h" || first === "--help") return { kind: "help" };
  if (first.startsWith("-")) return { kind: "launch", account: null, args: argv };
  if (isCommand(first)) return { kind: "command", name: first, args: rest };
  if (isHidden(first)) return { kind: "hidden", name: first, args: rest };
  if (first === MAIN) {
    if (!config.main.enabled) throw new XError(`the main identity is disabled; enable it with: xclaude set main --enable`);
    return { kind: "launch", account: MAIN, args: rest };
  }
  if (Object.hasOwn(config.accounts, first)) return { kind: "launch", account: first, args: rest };
  throw unknownAccount(first, config);
}

export function unknownAccount(word: string, config: Config): UsageError {
  const names = identities(config);
  const list = names.length ? `accounts: ${names.join(", ")}` : "no accounts yet; add one with: xclaude add <name>";
  return new UsageError(`unknown account or command "${word}" (${list})`);
}
