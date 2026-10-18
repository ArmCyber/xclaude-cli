// MCP servers from the ~/.claude login. `claude mcp add --scope user` keeps them
// in ~/.claude.json, and each account has its own .claude.json (F1), so they're
// missing from every account. Writing them into an account's .claude.json would
// race Claude Code, which rewrites that file on its own. Instead, a launch of an
// account that takes ~/.claude's settings (link/inherit.ts) passes them with
// --mcp-config, which adds servers to the account's own (F28). The file holds
// ~/.claude.json's mcpServers minus the names the account defines itself, so the
// account's own server of the same name wins.
import fs from "node:fs";
import path from "node:path";
import { readFileOrNull, removeTree, writeFileAtomic } from "../core/fsutil.ts";
import { accountDir, mkdirPrivate, type Paths } from "../core/paths.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The mcpServers of a .claude.json; null when it can't be read (Claude Code may be writing it). */
function serversIn(file: string): Record<string, unknown> | null {
  try {
    const json: unknown = JSON.parse(readFileOrNull(file) ?? "{}");
    if (!isRecord(json)) return null;
    return isRecord(json.mcpServers) ? json.mcpServers : {};
  } catch {
    return null;
  }
}

export function mcpFile(paths: Paths, account: string): string {
  return path.join(paths.inherit, `${account}.mcp.json`);
}

/** The ~/.claude login's user-scope servers the account gets, by name; null when a .claude.json can't be read. */
export function mcpServersFor(paths: Paths, account: string): Record<string, unknown> | null {
  const main = serversIn(path.join(paths.home, ".claude.json"));
  const own = serversIn(path.join(accountDir(paths, account), ".claude.json"));
  if (!main || !own) return null;
  return Object.fromEntries(Object.entries(main).filter(([name]) => !Object.hasOwn(own, name)));
}

/**
 * Brings the account's --mcp-config file in line and returns it, or null when
 * there's nothing to pass. While a .claude.json can't be read, the file from
 * the last launch is used as it is.
 */
export function prepareMcp(paths: Paths, account: string): string | null {
  const file = mcpFile(paths, account);
  const servers = mcpServersFor(paths, account);
  if (!servers) return fs.existsSync(file) ? file : null;
  if (!Object.keys(servers).length) {
    removeTree(file);
    return null;
  }
  const text = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
  if (readFileOrNull(file) !== text) {
    mkdirPrivate(paths.inherit);
    writeFileAtomic(file, text, { mode: 0o600 });
  }
  return file;
}

/** Deletes the account's --mcp-config file: `rm`, and `--inherit off`. */
export function forgetMcp(paths: Paths, account: string): void {
  removeTree(mcpFile(paths, account));
}
