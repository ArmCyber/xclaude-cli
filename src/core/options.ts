// A small parser for xclaude's own command options: --name value, --name=value,
// boolean flags and short aliases. Unknown options are usage errors.
import { UsageError } from "./errors.ts";

export interface OptionDef {
  /** Takes a value. */
  value?: boolean;
  /** May be given more than once (collected into a list). */
  repeat?: boolean;
  /** A one-letter alias, e.g. "y" for -y. */
  short?: string;
}

export interface Parsed {
  /** string for value options, string[] for repeatable ones, true for flags. */
  values: Record<string, string | string[] | true>;
  positionals: string[];
}

export function parseOptions(args: string[], defs: Record<string, OptionDef>, command: string): Parsed {
  const values: Parsed["values"] = {};
  const positionals: string[] = [];
  const byShort = new Map(Object.entries(defs).filter(([, d]) => d.short).map(([n, d]) => [`-${d.short}`, n]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const name = flag.startsWith("--") ? flag.slice(2) : byShort.get(flag);
    const def = name !== undefined ? defs[name] : undefined;
    if (name === undefined || !def) throw new UsageError(`${command}: unknown option ${flag} (see xclaude help ${command})`);
    let value: string | true = true;
    if (def.value) {
      if (eq > 0 && flag !== a) value = a.slice(eq + 1);
      else if (i + 1 < args.length) value = args[++i]!;
      else throw new UsageError(`${command}: ${flag} needs a value`);
    } else if (flag !== a) {
      throw new UsageError(`${command}: ${flag} doesn't take a value`);
    }
    if (def.repeat) values[name] = [...((values[name] as string[] | undefined) ?? []), value as string];
    else values[name] = value;
  }
  return { values, positionals };
}

export function stringOption(p: Parsed, name: string): string | undefined {
  const v = p.values[name];
  return typeof v === "string" ? v : undefined;
}
