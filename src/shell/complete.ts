// `xclaude __complete <shell> <cword> <words…>`: prints a
// directive (default, files, dirs or nospace) and then one candidate per line,
// with a tab-separated description for zsh. Best-effort: it never fails loudly.
import fs from "node:fs";
import path from "node:path";
import { FALLBACK_HELP, FALLBACK_SUBCOMMANDS, findOption, type HelpInfo, isSubcommand, loadHelp, longName, type OptionSpec } from "../claude/help.ts";
import { findClaude } from "../claude/resolve.ts";
import { COMMANDS, type Config, defaultsOf, describeDefaults, EFFORTS, identities, MAIN } from "../core/config.ts";
import type { Ctx } from "../ctx.ts";
import { leftoverNames } from "../link/leftover.ts";
import { Tmux } from "../tmux/client.ts";
import { listSessions } from "../tmux/sessions.ts";

export type Directive = "default" | "files" | "dirs" | "nospace";
export type ShellName = "bash" | "zsh";

export interface Item {
  value: string;
  description?: string;
}

export interface Completion {
  directive: Directive;
  items: Item[];
}

/** Common --model values; any other model name still works when typed. */
export const MODEL_ALIASES: readonly string[] = ["default", "best", "fable", "opus", "sonnet", "haiku", "opus[1m]", "sonnet[1m]", "opusplan"];

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  add: "add an account and log in",
  rm: "remove an account",
  ls: "list accounts and logins",
  set: "change an account's defaults",
  tmux: "Claude Code in tmux sessions",
  doctor: "check and repair",
  shell: "shell integration",
  guard: "disable bare claude",
  help: "help for a command",
};

const none = (): Completion => ({ directive: "default", items: [] });
const words = (values: readonly string[], describe?: (v: string) => string | undefined): Completion => ({
  directive: "default",
  items: values.map((value) => ({ value, ...(describe?.(value) ? { description: describe(value)! } : {}) })),
});

/**
 * The words before the cursor and the word being completed. bash splits
 * `--model=op` into `--model`, `=`, `op` (COMP_WORDBREAKS); they're joined back.
 */
export function logicalWords(shell: ShellName, words: string[], cword: number): { prior: string[]; cur: string } {
  let end = cword;
  let cur = words[cword] ?? "";
  if (shell === "bash") {
    if (cur === "=" && cword > 0) {
      cur = `${words[cword - 1]}=`;
      end = cword - 1;
    } else if (words[cword - 1] === "=" && cword > 1) {
      cur = `${words[cword - 2]}=${cur}`;
      end = cword - 2;
    }
  }
  const prior: string[] = [];
  const before = words.slice(0, end);
  for (let i = 0; i < before.length; i++) {
    if (shell === "bash" && before[i] === "=" && prior.length && i + 1 < before.length) {
      prior[prior.length - 1] += `=${before[++i]}`;
    } else {
      prior.push(before[i]!);
    }
  }
  return { prior, cur };
}

/** A tmux label from the current directory's name. */
export function suggestLabel(cwd: string): string | null {
  const label = path
    .basename(cwd)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return label || null;
}

/** Recent sessions of the current directory, from the shared projects/ (best-effort). */
export function resumeCandidates(store: string, cwd: string): Item[] {
  const dir = path.join(store, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  let files: Array<{ id: string; mtime: number; file: string }>;
  try {
    files = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => ({ id: n.slice(0, -".jsonl".length), file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }));
  } catch {
    return [];
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 30)
    .map((f) => {
      const title = sessionTitle(f.file);
      return title ? { value: f.id, description: title } : { value: f.id };
    });
}

/** A custom title, a summary, or the first prompt of a transcript, from its first 16 KB. */
function sessionTitle(file: string): string | null {
  let head: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(16_384);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  let prompt: string | null = null;
  for (const line of head.split("\n")) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof e.customTitle === "string" && e.customTitle) return clip(e.customTitle);
    if (e.type === "summary" && typeof e.summary === "string") return clip(e.summary);
    if (!prompt && e.type === "user") {
      const content = (e.message as { content?: unknown } | undefined)?.content;
      if (typeof content === "string") prompt = content;
      else if (Array.isArray(content)) {
        const text = content.find((c: { type?: string; text?: string }) => c?.type === "text")?.text;
        if (typeof text === "string") prompt = text;
      }
    }
  }
  return prompt ? clip(prompt) : null;
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

class Completer {
  readonly ctx: Ctx;
  readonly config: Config;
  private help: HelpInfo | null = null;

  constructor(ctx: Ctx, config: Config) {
    this.ctx = ctx;
    this.config = config;
  }

  /** Claude Code's parsed --help: the cache, or a one-time parse; the built-in lists without ~/.xclaude. */
  claudeHelp(): HelpInfo {
    if (this.help) return this.help;
    this.help = FALLBACK_HELP;
    if (fs.existsSync(this.ctx.paths.xhome)) {
      try {
        const claude = findClaude(this.ctx.env, this.config, this.ctx.paths.home, this.ctx.selfPath);
        this.help = loadHelp(claude, this.ctx.paths.cache, this.ctx.env);
      } catch {
        // keep the fallback
      }
    }
    return this.help;
  }

  describeIdentity(name: string): string {
    const d = defaultsOf(this.config, name);
    const parts = [name === MAIN ? "the ~/.claude login" : "account", d ? describeDefaults(d) : ""].filter(Boolean);
    return parts.join(" · ");
  }

  complete(args: string[], cur: string): Completion {
    const ids = identities(this.config);
    if (args.length === 0) {
      if (cur.startsWith("-")) return { directive: "default", items: [...this.claudeFlags(), { value: "--help" }, { value: "--version" }] };
      return {
        directive: "default",
        items: [
          ...COMMANDS.map((c) => ({ value: c, description: COMMAND_DESCRIPTIONS[c]! })),
          ...ids.map((n) => ({ value: n, description: this.describeIdentity(n) })),
        ],
      };
    }
    const [first = "", ...rest] = args;
    if (ids.includes(first)) return this.claudeArgs(rest, cur);
    if (first.startsWith("-")) return this.claudeArgs(args, cur); // the picker path
    switch (first) {
      case "add":
        return this.own(rest, cur, { "--model": "model", "--effort": "effort", "--args": "text" }, 1, () => []);
      case "rm":
        if (rest.includes("--leftovers")) return this.own(rest, cur, { "-y": null }, 0, () => []);
        return this.own(
          rest,
          cur,
          { "--keep-login": null, "--leftovers": null, "-y": null },
          1,
          () => [...Object.keys(this.config.accounts), ...leftoverNames(this.ctx.paths, this.config)],
          (n) => (this.config.accounts[n] ? this.describeIdentity(n) : "leftover folder of a removed account"),
        );
      case "set":
        return this.own(
          rest,
          cur,
          { "--model": "model", "--effort": "effort", "--args": "text", "--unset": "unset", "--enable": null, "--disable": null },
          1,
          () => [...Object.keys(this.config.accounts), MAIN],
        );
      case "tmux":
        return this.tmux(rest, cur);
      case "shell":
        if (rest.length === 0) return words(["install", "uninstall", "completion"]);
        if (rest[0] === "completion") return rest.length === 1 ? words(["bash", "zsh"]) : none();
        return rest[0] === "install" || rest[0] === "uninstall" ? words(["--bash", "--zsh"]) : none();
      case "guard":
        return rest.length === 0 ? words(["on", "off", "status"]) : none();
      case "doctor":
        return words(["--fix"]);
      case "help":
        return rest.length === 0 ? words(COMMANDS, (c) => COMMAND_DESCRIPTIONS[c]) : none();
      default:
        return none();
    }
  }

  /** xclaude's own options: flags, their values, and up to `max` positionals. */
  own(
    rest: string[],
    cur: string,
    flags: Record<string, "model" | "effort" | "unset" | "text" | null>,
    max: number,
    positional: () => string[],
    describe: (name: string) => string | undefined = (n) => (n === MAIN || this.config.accounts[n] ? this.describeIdentity(n) : undefined),
  ): Completion {
    const eq = cur.startsWith("--") ? cur.indexOf("=") : -1;
    if (eq > 0) return this.ownValues(flags[cur.slice(0, eq)] ?? null, cur.slice(0, eq + 1));
    const prev = rest[rest.length - 1];
    if (prev !== undefined && flags[prev]) return this.ownValues(flags[prev]!, "");
    if (cur.startsWith("-")) return words(Object.keys(flags));
    let positionals = 0;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a.startsWith("-")) {
        if (flags[a] && !a.includes("=")) i++;
      } else positionals++;
    }
    if (positionals >= max) return none();
    return words(positional(), describe);
  }

  ownValues(kind: "model" | "effort" | "unset" | "text" | null, prefix: string): Completion {
    const values = kind === "model" ? MODEL_ALIASES : kind === "effort" ? EFFORTS : kind === "unset" ? ["model", "effort", "args"] : [];
    return words(values.map((v) => `${prefix}${v}`));
  }

  claudeFlags(): Item[] {
    const items: Item[] = [];
    for (const o of this.claudeHelp().options) {
      const description = o.description ? clip(o.description.split(/(?<=\.)\s/)[0]!) : undefined;
      for (const n of o.names) items.push(description ? { value: n, description } : { value: n });
    }
    return items;
  }

  /** The option waiting for a value: the previous word, or a variadic list still going on. */
  pendingValue(args: string[]): OptionSpec | null {
    const help = this.claudeHelp();
    const last = args[args.length - 1];
    if (last?.startsWith("-") && !last.includes("=")) {
      const spec = findOption(help, last);
      return spec && spec.value !== "none" ? spec : null;
    }
    for (let i = args.length - 1; i >= 0; i--) {
      const a = args[i]!;
      if (a.startsWith("-")) {
        const spec = a.includes("=") ? undefined : findOption(help, a);
        return spec?.value === "variadic" ? spec : null;
      }
    }
    return null;
  }

  claudeArgs(args: string[], cur: string): Completion {
    const help = this.claudeHelp();
    if (args.length && isSubcommand(args[0], help)) return { directive: "files", items: [] };
    const eq = cur.startsWith("--") ? cur.indexOf("=") : -1;
    if (eq > 0) {
      const spec = findOption(help, cur.slice(0, eq));
      return spec && spec.value !== "none" ? this.claudeValues(spec, cur.slice(0, eq + 1)) : none();
    }
    if (!cur.startsWith("-")) {
      const pending = this.pendingValue(args);
      if (pending) return this.claudeValues(pending, "");
      if (args.length === 0) return words([...new Set([...help.subcommands, ...FALLBACK_SUBCOMMANDS])].sort());
      return none(); // a prompt
    }
    return { directive: "default", items: this.claudeFlags() };
  }

  claudeValues(spec: OptionSpec, prefix: string): Completion {
    const name = longName(spec);
    let values: readonly Item[] | null = null;
    if (name === "--model" || name === "--fallback-model") values = MODEL_ALIASES.map((value) => ({ value }));
    else if (name === "--effort") values = EFFORTS.map((value) => ({ value }));
    else if (spec.choices) values = spec.choices.map((value) => ({ value }));
    else if (name === "--resume") values = resumeCandidates(this.ctx.paths.store, this.ctx.cwd);
    else if (/dir/i.test(name) || /dir/i.test(spec.placeholder ?? "")) return { directive: "dirs", items: [] };
    else if (/path|file|config/i.test(spec.placeholder ?? "")) return { directive: "files", items: [] };
    if (!values) return none();
    return { directive: "default", items: values.map((v) => ({ ...v, value: `${prefix}${v.value}` })) };
  }

  labels(): string[] {
    try {
      return listSessions(new Tmux(this.ctx.env)).map((s) => s.label);
    } catch {
      return [];
    }
  }

  tmux(rest: string[], cur: string): Completion {
    if (rest.length === 0) return words(["new", "attach", "ls", "kill"]);
    const [sub, ...more] = rest;
    if (sub === "attach" || sub === "kill") return more.length === 0 ? words(this.labels()) : none();
    if (sub !== "new") return none();
    if (more.length === 0) {
      const label = suggestLabel(this.ctx.cwd);
      return !cur.startsWith("-") && label ? words([label]) : none();
    }
    const after = more.slice(1);
    if (after[after.length - 1] === "--dir" || cur.startsWith("--dir=")) return { directive: "dirs", items: [] };
    let i = 0;
    for (; i < after.length; i++) {
      if (after[i] === "--dir") i++;
      else if (!after[i]!.startsWith("--")) break;
    }
    if (i < after.length) return this.claudeArgs(after.slice(i + 1), cur); // past the account
    if (cur.startsWith("-")) return words(["--dir", "--detach", "--empty"]);
    return words(identities(this.config), (n) => this.describeIdentity(n));
  }
}

export function complete(ctx: Ctx, config: Config, shell: ShellName, cword: number, allWords: string[]): { completion: Completion; cur: string } {
  const { prior, cur } = logicalWords(shell, allWords, cword);
  const raw = new Completer(ctx, config).complete(prior.slice(1), cur);
  const items = raw.items.filter((i) => i.value.startsWith(cur));
  return { completion: { directive: raw.directive, items }, cur };
}

/** The directive line, then candidates; bash gets only the part after `=`, which is what readline replaces. */
export function formatCompletion(c: Completion, shell: ShellName, cur: string): string {
  const eq = cur.startsWith("-") ? cur.indexOf("=") : -1;
  const lines: string[] = [c.directive];
  for (const item of c.items) {
    const value = shell === "bash" && eq > 0 ? item.value.slice(eq + 1) : item.value;
    lines.push(shell === "zsh" && item.description ? `${value}\t${item.description.replace(/[\t\n]/g, " ")}` : value);
  }
  return `${lines.join("\n")}\n`;
}
