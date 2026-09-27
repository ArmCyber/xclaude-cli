// Finding the real `claude`. Resolved on every launch and
// never cached, because auto-updates move the versioned file.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../core/config.ts";
import { XError } from "../core/errors.ts";
import { type Env, realpathOrNull } from "../core/paths.ts";

export const INSTALL_HINT = "install it with: curl -fsSL https://claude.ai/install.sh | bash (or npm i -g @anthropic-ai/claude-code)";

export function isExecutableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The fixed places checked last. */
export function fallbackLocations(home: string): string[] {
  return [path.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"];
}

/**
 * The claude binary to run, checking in order: XCLAUDE_CLAUDE_PATH, claudePath
 * in the config, the first `claude` on PATH whose real path isn't xclaude
 * itself, then the fixed locations. An explicit setting that doesn't work is an
 * error rather than a silent fallback.
 */
export function findClaude(env: Env, config: Config, home: string, selfPath: string | null): string {
  const explicit: Array<[string | undefined | null, string]> = [
    [env.XCLAUDE_CLAUDE_PATH, "XCLAUDE_CLAUDE_PATH"],
    [config.claudePath, "claudePath in ~/.xclaude/config.json"],
  ];
  for (const [value, where] of explicit) {
    if (!value) continue;
    if (isExecutableFile(value)) return value;
    throw new XError(`${where} is set to ${value}, which isn't an executable file`);
  }

  const self = selfPath ? realpathOrNull(selfPath) : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "claude");
    if (!isExecutableFile(candidate)) continue;
    if (self && realpathOrNull(candidate) === self) continue; // a `claude` that is xclaude itself
    return candidate;
  }
  for (const candidate of fallbackLocations(home)) {
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new XError(`Claude Code isn't installed (no \`claude\` found); ${INSTALL_HINT}`);
}
