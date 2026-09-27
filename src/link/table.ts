// The share table: the single source of truth for what's shared,
// used by the link engine, doctor and the docs.
import type { Config } from "../core/config.ts";
import type { Switches } from "../switches.ts";

/** Shared as a file link. */
export const HISTORY = "history.jsonl";

/** Shared through an import stub. */
export const STUB = "CLAUDE.md";

/** Shared as directory links into ~/.claude. */
export const SHARED_DIRS: readonly string[] = [
  "projects",
  "sessions",
  "session-env",
  "file-history",
  "tasks",
  "todos",
  "teams",
  "plans",
  "paste-cache",
  "image-cache",
  "uploads",
  "downloads",
  "debug",
  "chrome",
  "skills",
  "agents",
  "commands",
  "rules",
  "output-styles",
  "themes",
  "workflows",
  "hooks",
  "agent-memory",
  "memory",
  "plugins",
];

/** Linked only while ~/.claude has one. */
export const OPTIONAL_DIRS: ReadonlySet<string> = new Set(["memory"]);

/** Never shared, whatever the config says (invariant 4). */
export const NEVER_SHARED: readonly string[] = [
  ".claude.json",
  ".claude.json.backup",
  ".credentials.json",
  "settings.json",
  "settings.local.json",
  "keybindings.json",
  "remote-settings.json",
  "policy-limits.json",
  "jobs",
  "daemon",
];

/** Per account and never linked: identity, settings, process state and caches. */
export const PER_ACCOUNT: readonly string[] = [
  ...NEVER_SHARED,
  "backups",
  "cache",
  "shell-snapshots",
  "stats-cache.json",
  "usage-data",
  "ide",
];

/** Claude Code's own state entries, as observed in v2.1.282 (Appendix A in docs/architecture.md). */
export const APPENDIX_A: readonly string[] = [
  ".claude.json",
  ".claude.json.backup",
  ".credentials.json",
  "projects",
  "sessions",
  "todos",
  "shell-snapshots",
  "statsig",
  "file-history",
  "history.jsonl",
  "ide",
  "logs",
  "backups",
  ".session_ingress_token",
  "policy-limits.json",
  "remote-settings.json",
  "hfi-auth.json",
  "daemon",
  "jobs",
  "teams",
  "usage-data",
  "shares",
  "state",
  "uploads",
  "feedback",
  "feedback-bundles",
  "plans",
  "telemetry",
  "dump-prompts",
  "debug",
  "traces",
  "startup-perf",
  "cache",
  "mcp-discovery-cache",
  "mcp-needs-auth-cache.json",
  "gh-pr-status-cache.json",
  "tasks",
  "local",
  "antproto.json",
  "ccr",
  "session-env",
  "bridge-spawn",
  "active-time.json",
  "loop.md",
  "server-sessions.json",
  "image-cache",
  "paste-cache",
  "file-transfers",
  "mcp-skill-archives",
  "stats-cache.json",
  "computer-use.lock",
  "server.lock",
  "api-dumps",
  "chrome",
  "downloads",
  "local-settings",
  "project-settings",
  "remote",
  "scratch",
  "seed-admin",
  "storage-v2",
  "systemd",
];

/** Appendix A entries whose names vary: daemon.log*, policy-limits.json.stamp.json. */
const APPENDIX_A_PATTERNS: readonly RegExp[] = [/^daemon\.log/, /^policy-limits\.json\.stamp\.json$/];

export interface ShareTable {
  /** Directory entries linked into the store. */
  dirs: string[];
  /** history.jsonl is linked. */
  history: boolean;
  /** Accounts get the CLAUDE.md stub. */
  stub: boolean;
  /** share.add names refused: never-shared entries (any case) and names that look like files. */
  refused: string[];
}

/** The effective table: built-in entries, the switches, then share.add and share.remove. */
export function shareTable(config: Config, switches: Switches): ShareTable {
  const off = new Set<string>(config.share.remove);
  if (!switches.shareSessions) off.add("sessions");
  if (!switches.shareSkills) off.add("skills");
  if (!switches.shareChrome) off.add("chrome");

  const dirs = SHARED_DIRS.filter((e) => !off.has(e));
  if (switches.linkIde && !off.has("ide")) dirs.push("ide");

  const refused: string[] = [];
  for (const name of config.share.add) {
    if (!isShareableDirName(name)) refused.push(name);
    else if (!dirs.includes(name) && !off.has(name)) dirs.push(name);
  }
  return {
    dirs,
    history: switches.shareHistory && !off.has(HISTORY),
    stub: !off.has(STUB),
    refused,
  };
}

/**
 * share.add takes directory names for entries xclaude doesn't know yet. Entries
 * kept per account are refused whatever their case (macOS volumes are
 * case-insensitive, so "Jobs" is jobs), and so are names that look like files:
 * sharing one would create a directory in its place.
 */
export function isShareableDirName(name: string): boolean {
  const lower = name.toLowerCase();
  // Everything kept per account: identity, settings, process state, caches
  // and the rest of Appendix A (ide only through the linkIde switch).
  const perAccount = [...PER_ACCOUNT, ...APPENDIX_A, HISTORY, STUB].filter((n) => !SHARED_DIRS.includes(n)).map((n) => n.toLowerCase());
  if (perAccount.includes(lower)) return false;
  return !name.startsWith(".") && !/\.(json|jsonl|md|txt|log|lock|yaml|yml|toml|db|sqlite)$/i.test(name);
}

/** Entries every scan skips: locks, xclaude's own leftovers, temp files, Finder metadata. */
export function isIgnored(name: string): boolean {
  return (
    name.endsWith(".lock") ||
    name.startsWith(".xclaude-") ||
    name === ".DS_Store" ||
    /\.tmp(?:[.-]|$)/.test(name) // Claude Code's atomic-write temp files
  );
}

/** Known to xclaude: shared, per account, or one of Claude Code's own entries. */
export function isKnown(name: string, table: ShareTable): boolean {
  return (
    table.dirs.includes(name) ||
    name === HISTORY ||
    name === STUB ||
    SHARED_DIRS.includes(name) ||
    PER_ACCOUNT.includes(name) ||
    APPENDIX_A.includes(name) ||
    APPENDIX_A_PATTERNS.some((re) => re.test(name))
  );
}
