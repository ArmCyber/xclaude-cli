// ~/.xclaude/config.json.
import fs from "node:fs";
import { XError } from "./errors.ts";
import { errCode, writeFileAtomic } from "./fsutil.ts";
import { ensureXHome, type Paths, tildify } from "./paths.ts";

/** What --effort accepts. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export type Effort = (typeof EFFORTS)[number];

/** xclaude's own commands. */
export const COMMANDS = ["add", "rm", "ls", "set", "tmux", "doctor", "shell", "guard", "help"] as const;

/** The reserved name of the main identity, the login stored in ~/.claude itself. */
export const MAIN = "main";

const ACCOUNT_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export interface Defaults {
  model: string | null;
  effort: Effort | null;
  args: string[];
}

export interface MainConfig extends Defaults {
  enabled: boolean;
}

export interface Config {
  version: 1;
  main: MainConfig;
  accounts: Record<string, Defaults>;
  share: { add: string[]; remove: string[] };
  guard: boolean;
  tmux: { statusRight: boolean };
  claudePath: string | null;
}

export function defaultConfig(): Config {
  return {
    version: 1,
    main: { enabled: false, model: null, effort: null, args: [] },
    accounts: {},
    share: { add: [], remove: [] },
    guard: false,
    tmux: { statusRight: true },
    claudePath: null,
  };
}

export function isEffort(value: string): value is Effort {
  return (EFFORTS as readonly string[]).includes(value);
}

/** Why `name` can't be an account name, or null if it can. */
export function accountNameProblem(name: string): string | null {
  if (name === MAIN) return `"${MAIN}" is reserved for the main identity (xclaude set main --enable)`;
  if ((COMMANDS as readonly string[]).includes(name)) return `"${name}" is reserved: it's an xclaude command`;
  if (name.startsWith("-") || name.startsWith("_")) return `"${name}" is reserved: names can't start with - or _`;
  if (!ACCOUNT_NAME.test(name)) {
    return `"${name}" isn't a valid account name: use lowercase letters, digits and dashes, start with a letter, at most 32 characters`;
  }
  return null;
}

/** A name that can be a share-table entry: one path component. */
function isEntryName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

class ConfigProblem extends Error {}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function field<T>(obj: Json, key: string, where: string, fallback: T, check: (v: unknown) => v is T, expected: string): T {
  if (!(key in obj) || obj[key] === undefined) return fallback;
  const v = obj[key];
  if (!check(v)) throw new ConfigProblem(`${where}${key} must be ${expected}`);
  return v;
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStringOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length > 0);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isEffortOrNull = (v: unknown): v is Effort | null => v === null || (typeof v === "string" && isEffort(v));

function parseDefaults(raw: unknown, where: string): Defaults & Json {
  if (!isObject(raw)) throw new ConfigProblem(`${where.replace(/\.$/, "")} must be an object`);
  return {
    ...raw,
    model: field(raw, "model", where, null, isStringOrNull, "a model name or null"),
    effort: field(raw, "effort", where, null, isEffortOrNull, `one of ${EFFORTS.join(", ")}, or null`),
    args: field(raw, "args", where, [], isStringArray, "a list of strings"),
  };
}

/** Validates parsed JSON and fills in missing fields. Unknown keys are kept. */
export function validateConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new ConfigProblem("the top level must be an object");
  const version = raw.version ?? 1;
  if (version !== 1) throw new ConfigProblem(`version ${JSON.stringify(version)} isn't supported (expected 1)`);

  const mainRaw = raw.main ?? {};
  const main = parseDefaults(mainRaw, "main.");
  const enabled = field(mainRaw as Json, "enabled", "main.", false, isBool, "true or false");

  const accountsRaw = raw.accounts ?? {};
  if (!isObject(accountsRaw)) throw new ConfigProblem("accounts must be an object");
  const accounts: Record<string, Defaults> = {};
  for (const [name, value] of Object.entries(accountsRaw)) {
    const problem = accountNameProblem(name);
    if (problem) throw new ConfigProblem(`accounts: ${problem}`);
    accounts[name] = parseDefaults(value, `accounts.${name}.`);
  }

  const shareRaw = raw.share ?? {};
  if (!isObject(shareRaw)) throw new ConfigProblem("share must be an object");
  const share = {
    ...shareRaw,
    add: field(shareRaw, "add", "share.", [], isStringArray, "a list of entry names"),
    remove: field(shareRaw, "remove", "share.", [], isStringArray, "a list of entry names"),
  };
  for (const name of [...share.add, ...share.remove]) {
    if (!isEntryName(name)) throw new ConfigProblem(`share: "${name}" isn't an entry name (one path component)`);
  }

  const tmuxRaw = raw.tmux ?? {};
  if (!isObject(tmuxRaw)) throw new ConfigProblem("tmux must be an object");

  return {
    ...raw,
    version: 1,
    main: { ...main, enabled },
    accounts,
    share,
    guard: field(raw, "guard", "", false, isBool, "true or false"),
    tmux: { ...tmuxRaw, statusRight: field(tmuxRaw, "statusRight", "tmux.", true, isBool, "true or false") },
    claudePath: field(raw, "claudePath", "", null, isStringOrNull, "a path or null"),
  };
}

/** Parses config.json text; throws an XError that names the file and the problem. */
export function parseConfig(text: string, file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new XError(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
  try {
    return validateConfig(raw);
  } catch (e) {
    if (e instanceof ConfigProblem) throw new XError(`${file}: ${e.message}`);
    throw e;
  }
}

export interface LoadedConfig {
  config: Config;
  /** True when this call created ~/.xclaude (the first run). */
  created: boolean;
}

/**
 * Reads the config. When it's missing: with create, writes the default config
 * and an empty state (the first run); without, returns the defaults.
 */
export function loadConfig(paths: Paths, opts: { create: boolean }): LoadedConfig {
  let text: string;
  try {
    text = fs.readFileSync(paths.config, "utf8");
  } catch (e) {
    if (errCode(e) !== "ENOENT") throw e;
    const config = defaultConfig();
    if (!opts.create) return { config, created: false };
    ensureXHome(paths);
    saveConfig(paths, config);
    if (!fs.existsSync(paths.state)) writeFileAtomic(paths.state, "{}\n", { mode: 0o600 });
    return { config, created: true };
  }
  return { config: parseConfig(text, tildify(paths.config, paths.home)), created: false };
}

export function saveConfig(paths: Paths, config: Config): void {
  ensureXHome(paths);
  writeFileAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, fsync: true });
}

/** Enabled identities, in config order; the main identity last, when enabled. */
export function identities(config: Config): string[] {
  const names = Object.keys(config.accounts);
  if (config.main.enabled) names.push(MAIN);
  return names;
}

/** An identity's defaults, or null if it doesn't exist or is disabled. */
export function defaultsOf(config: Config, name: string): Defaults | null {
  if (name === MAIN) return config.main.enabled ? config.main : null;
  return Object.hasOwn(config.accounts, name) ? config.accounts[name]! : null;
}

/** "opus · max · --chrome", or "" when nothing is set. */
export function describeDefaults(d: Defaults): string {
  const parts = [d.model, d.effort, d.args.length ? d.args.join(" ") : null].filter((x): x is string => Boolean(x));
  return parts.join(" · ");
}
