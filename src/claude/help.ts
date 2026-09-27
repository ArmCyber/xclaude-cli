// Claude Code's flags and subcommands, parsed from `claude --help`
// and cached per build in ~/.xclaude/cache/, keyed by the binary's real path
// and mtime. Built-in lists are the fallback.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readFileOrNull, writeFileAtomic } from "../core/fsutil.ts";
import { type Env, mkdirPrivate, realpathOrNull } from "../core/paths.ts";
import { shellWay } from "./runnable.ts";

export type ValueKind = "none" | "required" | "optional" | "variadic";

export interface OptionSpec {
  /** All spellings, e.g. ["-c", "--continue"] or ["--allowedTools", "--allowed-tools"]. */
  names: string[];
  value: ValueKind;
  /** e.g. "directories", "file-or-json". */
  placeholder?: string;
  /** From "(choices: …)" in the description. */
  choices?: string[];
  description: string;
}

export interface HelpInfo {
  options: OptionSpec[];
  subcommands: string[];
}

/**
 * Subcommands that always count, parsed or not. Some are hidden from --help
 * (`daemon`), so the parsed list is extended with these rather than replaced.
 */
export const FALLBACK_SUBCOMMANDS: readonly string[] = ["auth", "mcp", "plugin", "agents", "daemon", "doctor", "update", "install", "setup-token"];

const opt = (names: string[], value: ValueKind, placeholder?: string, choices?: string[]): OptionSpec => ({
  names,
  value,
  ...(placeholder ? { placeholder } : {}),
  ...(choices ? { choices } : {}),
  description: "",
});

/** Used when `claude --help` can't be run or parsed. */
export const FALLBACK_HELP: HelpInfo = {
  subcommands: [...FALLBACK_SUBCOMMANDS],
  options: [
    opt(["--add-dir"], "variadic", "directories"),
    opt(["--agent"], "required", "agent"),
    opt(["--agents"], "required", "json-or-file"),
    opt(["--allowedTools", "--allowed-tools"], "variadic", "tools"),
    opt(["--append-system-prompt"], "required", "prompt"),
    opt(["--chrome"], "none"),
    opt(["-c", "--continue"], "none"),
    opt(["--dangerously-skip-permissions"], "none"),
    opt(["-d", "--debug"], "optional", "filter"),
    opt(["--debug-file"], "required", "path"),
    opt(["--disallowedTools", "--disallowed-tools"], "variadic", "tools"),
    opt(["--effort"], "required", "level"),
    opt(["--fallback-model"], "required", "model"),
    opt(["--fork-session"], "none"),
    opt(["-h", "--help"], "none"),
    opt(["--ide"], "none"),
    opt(["--input-format"], "required", "format", ["text", "stream-json"]),
    opt(["--mcp-config"], "variadic", "configs"),
    opt(["--model"], "required", "model"),
    opt(["-n", "--name"], "required", "name"),
    opt(["--no-chrome"], "none"),
    opt(["--output-format"], "required", "format", ["text", "json", "stream-json"]),
    opt(["--permission-mode"], "required", "mode", ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]),
    opt(["--plugin-dir"], "required", "path"),
    opt(["-p", "--print"], "none"),
    opt(["-r", "--resume"], "optional", "value"),
    opt(["--session-id"], "required", "uuid"),
    opt(["--settings"], "required", "file-or-json"),
    opt(["--strict-mcp-config"], "none"),
    opt(["--system-prompt"], "required", "prompt"),
    opt(["--tools"], "variadic", "tools"),
    opt(["--verbose"], "none"),
    opt(["-v", "--version"], "none"),
    opt(["-w", "--worktree"], "optional", "name"),
  ],
};

function valueKind(placeholder: string | undefined): ValueKind {
  if (!placeholder) return "none";
  const variadic = placeholder.includes("...");
  if (placeholder.startsWith("<")) return variadic ? "variadic" : "required";
  return "optional";
}

function parseChoices(description: string): string[] | undefined {
  const m = /\(choices: ([^)]*)\)/.exec(description);
  if (!m) return undefined;
  const choices = [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
  return choices.length ? choices : undefined;
}

/** Parses commander-style `claude --help` output. */
export function parseHelp(text: string): HelpInfo {
  const options: OptionSpec[] = [];
  const subcommands: string[] = [];
  let section = "";
  let current: OptionSpec | null = null;
  const finish = () => {
    if (!current) return;
    current.description = current.description.replace(/\s+/g, " ").trim();
    const choices = parseChoices(current.description);
    if (choices) current.choices = choices;
    options.push(current);
    current = null;
  };

  for (const line of text.split("\n")) {
    const header = /^([A-Z][A-Za-z ]*):\s*$/.exec(line);
    if (header) {
      finish();
      section = header[1]!;
      continue;
    }
    if (section === "Options") {
      const m = /^ {2}(-\S.*)$/.exec(line);
      if (m) {
        finish();
        // "-d, --debug [filter]   Enable …": the spec ends at the first run of 2+ spaces.
        const [spec = "", ...rest] = m[1]!.split(/\s{2,}/);
        const tokens = spec.split(/,?\s+/).filter(Boolean);
        const names = tokens.filter((t) => t.startsWith("-")).map((t) => t.replace(/,$/, ""));
        const placeholder = tokens.find((t) => t.startsWith("<") || t.startsWith("["));
        current = {
          names,
          value: valueKind(placeholder),
          ...(placeholder ? { placeholder: placeholder.replace(/^[<[]|\.{3}|[>\]]$/g, "") } : {}),
          description: rest.join(" "),
        };
      } else if (current && /^\s{3,}\S/.test(line)) {
        current.description += ` ${line.trim()}`;
      } else if (line.trim() === "") {
        finish();
      }
    } else if (section === "Commands") {
      const m = /^ {2}([a-z][\w|-]*)/.exec(line);
      if (m) subcommands.push(...m[1]!.split("|"));
    }
  }
  finish();
  return { options, subcommands };
}

/** Finds an option by any spelling ("--model", "-n"); `--flag=value` is looked up by its flag. */
export function findOption(help: HelpInfo, arg: string): OptionSpec | undefined {
  const flag = arg.startsWith("--") ? arg.split("=")[0]! : arg;
  return help.options.find((o) => o.names.includes(flag));
}

/** The long spelling of an option, or its first one. */
export function longName(o: OptionSpec): string {
  return o.names.find((n) => n.startsWith("--")) ?? o.names[0]!;
}

export function isSubcommand(word: string | undefined, help: HelpInfo | null): boolean {
  if (!word || word.startsWith("-")) return false;
  return FALLBACK_SUBCOMMANDS.includes(word) || Boolean(help?.subcommands.includes(word));
}

interface CacheFile {
  key: { path: string; mtimeMs: number; size: number };
  help: HelpInfo;
}

/**
 * The parsed help of a claude binary, from the cache when the binary is
 * unchanged; otherwise runs `claude --help` once and caches the result. When
 * that fails, the built-in lists are used (and cached) until the binary changes.
 */
export function loadHelp(claude: string, cacheDir: string, env: Env): HelpInfo {
  const real = realpathOrNull(claude) ?? claude;
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return FALLBACK_HELP;
  }
  const key = { path: real, mtimeMs: st.mtimeMs, size: st.size };
  const file = path.join(cacheDir, "claude-help.json");
  try {
    const cached = JSON.parse(readFileOrNull(file) ?? "null") as CacheFile | null;
    if (cached && cached.key.path === key.path && cached.key.mtimeMs === key.mtimeMs && cached.key.size === key.size) {
      return cached.help;
    }
  } catch {
    // a corrupt cache is simply rebuilt
  }

  const res = spawnSync(...shellWay(claude, ["--help"]), {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let help = res.status === 0 && res.stdout ? parseHelp(res.stdout) : FALLBACK_HELP;
  // Output we don't recognize means the built-in lists, remembered for this
  // build too, so launches don't keep running `claude --help`.
  if (help.options.length < 5) help = FALLBACK_HELP;
  try {
    mkdirPrivate(cacheDir);
    writeFileAtomic(file, `${JSON.stringify({ key, help } satisfies CacheFile)}\n`, { mode: 0o600 });
  } catch {
    // caching is an optimization only
  }
  return help;
}
