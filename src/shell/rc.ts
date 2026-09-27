// The rc block: one small block per rc file that sources a
// generated init file. Re-running replaces the block; the rc file itself is
// never edited again after install.
import fs from "node:fs";
import path from "node:path";
import { XError } from "../core/errors.ts";
import { errCode, readFileOrNull, writeFileAtomic } from "../core/fsutil.ts";
import { type Env, realpathOrNull } from "../core/paths.ts";

export type Shell = "bash" | "zsh";

export const START = "# >>> xclaude >>>";
export const END = "# <<< xclaude <<<";

/** Double-quotes a path for sh. */
export function dquote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function blockFor(initFile: string): string {
  const q = dquote(initFile);
  return `${START}\n# Managed by \`xclaude shell install\`. Remove with \`xclaude shell uninstall\`.\n[ -f ${q} ] && . ${q}\n${END}\n`;
}

/** The block's line range, or null; a start marker without an end marker is an error. */
function findBlock(lines: string[], file: string): [number, number] | null {
  const start = lines.findIndex((l) => l.trim() === START);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === END);
  if (end < 0) {
    throw new XError(`${file} has "${START}" without "${END}"; fix or remove that block by hand, then run this again`);
  }
  return [start, end];
}

/** The text with the block replaced in place, or appended when there's none. */
export function upsertBlock(text: string, block: string, file: string): string {
  const lines = text.split("\n");
  const range = findBlock(lines, file);
  const blockLines = block.replace(/\n$/, "").split("\n");
  if (range) {
    lines.splice(range[0], range[1] - range[0] + 1, ...blockLines);
    return lines.join("\n");
  }
  if (text === "") return block;
  return `${text}${text.endsWith("\n") ? "" : "\n"}\n${block}`;
}

/** The text without the block (and without the blank line install added before it). */
export function removeBlock(text: string, file: string): { text: string; found: boolean } {
  const lines = text.split("\n");
  const range = findBlock(lines, file);
  if (!range) return { text, found: false };
  let [start] = range;
  const end = range[1];
  if (start > 0 && lines[start - 1] === "" && (lines[end + 1] === undefined || lines[end + 1] === "")) start--;
  lines.splice(start, end - start + 1);
  return { text: lines.join("\n"), found: true };
}

export interface RcTarget {
  shell: Shell;
  file: string;
}

/** Whether a bash_profile already loads ~/.bashrc. */
export function sourcesBashrc(text: string): boolean {
  return text.split("\n").some((l) => !/^\s*#/.test(l) && /\.bashrc\b/.test(l) && /(^|[\s;&|({])(\.|source)\s/.test(l));
}

/**
 * The rc files to edit: ${ZDOTDIR:-$HOME}/.zshrc and ~/.bashrc, whichever exist
 * (or the ones asked for). On macOS, login shells read ~/.bash_profile instead
 * of ~/.bashrc, so an existing one that doesn't source ~/.bashrc is added too.
 */
export function rcTargets(env: Env, home: string, platform: NodeJS.Platform, want: { bash?: boolean; zsh?: boolean }): RcTarget[] {
  const zshrc = path.join(env.ZDOTDIR || home, ".zshrc");
  const bashrc = path.join(home, ".bashrc");
  const explicit = want.bash || want.zsh;
  const targets: RcTarget[] = [];
  if (explicit ? want.zsh : fs.existsSync(zshrc)) targets.push({ shell: "zsh", file: zshrc });
  if (explicit ? want.bash : fs.existsSync(bashrc)) {
    targets.push({ shell: "bash", file: bashrc });
    const profile = path.join(home, ".bash_profile");
    const text = platform === "darwin" ? readFileOrNull(profile) : null;
    if (text !== null && !sourcesBashrc(text)) targets.push({ shell: "bash", file: profile });
  }
  return targets;
}

export type RcOutcome = { file: string; status: "written" | "unchanged" | "manual"; text?: string };

/**
 * Writes new rc text. A symlinked rc file (dotfile managers) is edited at its
 * target and never replaced by a regular file. When that isn't writable, the
 * caller prints the block for a manual install.
 */
export function writeRc(file: string, text: string, previous: string | null): RcOutcome {
  if (text === previous) return { file, status: "unchanged" };
  const real = realpathOrNull(file);
  // A link whose target doesn't exist yet (a dotfiles repo not cloned) must stay a link.
  if (real === null && fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return { file, status: "manual", text };
  try {
    const target = real ?? file;
    fs.accessSync(path.dirname(target), fs.constants.W_OK);
    if (previous !== null) fs.accessSync(target, fs.constants.W_OK);
    writeFileAtomic(target, text, { mode: 0o644 });
    return { file, status: "written" };
  } catch (e) {
    if (errCode(e) === "EACCES" || errCode(e) === "EPERM" || errCode(e) === "EROFS") return { file, status: "manual", text };
    throw e;
  }
}

/** Every rc file xclaude may have edited. */
export function knownRcFiles(env: Env, home: string): RcTarget[] {
  return [
    { shell: "zsh", file: path.join(env.ZDOTDIR || home, ".zshrc") },
    { shell: "bash", file: path.join(home, ".bashrc") },
    { shell: "bash", file: path.join(home, ".bash_profile") },
  ];
}

/** The rc files that currently have the block. */
export function installedIn(env: Env, home: string): string[] {
  return knownRcFiles(env, home)
    .filter((t) => (readFileOrNull(t.file) ?? "").split("\n").some((l) => l.trim() === START))
    .map((t) => t.file);
}
