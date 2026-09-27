// xclaude tmux new|attach|ls|kill
import fs from "node:fs";
import path from "node:path";
import { type Config, defaultsOf } from "../core/config.ts";
import { EXIT_OK, UsageError, XError } from "../core/errors.ts";
import { DASH, formatTable } from "../core/format.ts";
import { tildify } from "../core/paths.ts";
import { quoteShellWords } from "../core/shellwords.ts";
import type { Ctx } from "../ctx.ts";
import { unknownAccount } from "../grammar.ts";
import { chooseAccount } from "../launch/launch.ts";
import { pick } from "../launch/picker.ts";
import { claudeStates } from "../tmux/claude-state.ts";
import { Tmux } from "../tmux/client.ts";
import { findByLabel, LABEL, listSessions, sessionName, type XSession } from "../tmux/sessions.ts";

const NEW_USAGE = "usage: xclaude tmux new <label> [--dir <path>] [--detach] [--empty] [<account> [claude args…]]";

export interface NewRequest {
  label: string;
  dir: string | null;
  detach: boolean;
  empty: boolean;
  account: string | null;
  claudeArgs: string[];
}

/**
 * xclaude's options come right after the label, long names only (Claude Code
 * owns short flags such as -d). The first token that isn't one is the account;
 * everything after it goes to Claude.
 */
export function parseNew(args: string[]): NewRequest {
  const [label, ...rest] = args;
  if (!label || label.startsWith("-")) throw new UsageError(NEW_USAGE);
  if (!LABEL.test(label)) {
    throw new UsageError(`"${label}" isn't a valid label: letters, digits, _ and -, starting with a letter or digit, at most 64 characters`);
  }
  const req: NewRequest = { label, dir: null, detach: false, empty: false, account: null, claudeArgs: [] };
  let i = 0;
  for (; i < rest.length && rest[i]!.startsWith("--"); i++) {
    const a = rest[i]!;
    if (a === "--detach") req.detach = true;
    else if (a === "--empty") req.empty = true;
    else if (a === "--dir") {
      const v = rest[++i];
      if (v === undefined) throw new UsageError("tmux new: --dir needs a path");
      req.dir = v;
    } else if (a.startsWith("--dir=")) req.dir = a.slice("--dir=".length);
    else throw new UsageError(`tmux new: unknown option ${a} (xclaude's options come right after the label, Claude Code's after the account)`);
  }
  req.account = rest[i] ?? null;
  req.claudeArgs = rest.slice(i + 1);
  if (req.empty && req.account) throw new UsageError("tmux new: --empty and an account don't go together");
  return req;
}

function describeSession(s: XSession, home: string): string {
  return `${s.account ?? "empty"}, ${tildify(s.dir, home)}`;
}

/** Attaches outside tmux (replacing the process) or switches the client inside it. */
async function attachTo(ctx: Ctx, tmux: Tmux, id: string): Promise<number> {
  if (ctx.env.TMUX) {
    tmux.must(["switch-client", "-t", id]);
    return EXIT_OK;
  }
  return ctx.exec(tmux.bin, [tmux.bin, "attach-session", "-t", id], tmux.env);
}

/**
 * Prepends the account to this session's status-right (copied from the global
 * value) and raises status-right-length to fit: the default 40 is already
 * filled by the default status-right. #{@xclaude_account} stays available for
 * custom status lines.
 */
function showAccount(tmux: Tmux, id: string, account: string): void {
  const prefix = `[${account}] `;
  const right = tmux.must(["show-options", "-gv", "status-right"]).replace(/\n$/, "");
  const length = Number(tmux.must(["show-options", "-gv", "status-right-length"]).trim()) || 40;
  tmux.must(["set-option", "-t", id, "status-right", `${prefix}${right}`]);
  tmux.must(["set-option", "-t", id, "status-right-length", String(length + prefix.length)]);
}

async function tmuxNew(ctx: Ctx, config: Config, args: string[]): Promise<number> {
  const req = parseNew(args);
  const tmux = new Tmux(ctx.env);
  tmux.requireVersion();

  let account = req.account;
  if (!req.empty) {
    account ??= await chooseAccount(ctx, config, `Run Claude Code in tmux session "${req.label}" as`);
    if (!defaultsOf(config, account)) throw unknownAccount(account, config);
  }
  const dir = path.resolve(ctx.cwd, req.dir ?? ".");
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new XError(`--dir ${req.dir}: not a directory`);

  const existing = findByLabel(listSessions(tmux), req.label);
  if (existing) {
    throw new XError(`"${req.label}" is running (${describeSession(existing, ctx.paths.home)}): xclaude tmux attach ${req.label}, or kill it first`);
  }
  const name = sessionName(account, req.label);
  if (tmux.hasSession(name)) throw new XError(`a tmux session named "${name}" exists but isn't xclaude's; rename or end it first`);

  const id = tmux.must(["new-session", "-d", "-P", "-F", "#{session_id}", "-s", name, "-c", dir]).trim();
  const options: Array<[string, string]> = [
    ["@xclaude", "1"],
    ["@xclaude_label", req.label],
    ["@xclaude_account", account ?? ""],
    ["@xclaude_dir", dir],
  ];
  for (const [key, value] of options) tmux.must(["set-option", "-t", id, key, value]);
  if (account && config.tmux.statusRight) showAccount(tmux, id, account);

  if (account) {
    // Typed into the session's shell: exiting Claude leaves a shell, and up-arrow reruns it.
    // -l sends the text literally, so words like Enter or C-c in the arguments stay text.
    tmux.must(["send-keys", "-t", id, "-l", "--", quoteShellWords(["xclaude", account, ...req.claudeArgs])]);
    tmux.must(["send-keys", "-t", id, "Enter"]);
  }

  if (req.detach) {
    ctx.io.err(`xclaude: started tmux session "${req.label}"; attach with: xclaude tmux attach ${req.label}\n`);
    return EXIT_OK;
  }
  return attachTo(ctx, tmux, id);
}

function noSessions(): XError {
  return new XError("no xclaude tmux sessions; start one with: xclaude tmux new <label> [<account>]");
}

function requireSession(sessions: XSession[], label: string): XSession {
  const s = findByLabel(sessions, label);
  if (s) return s;
  const labels = sessions.map((x) => x.label);
  throw new XError(`no xclaude tmux session "${label}"${labels.length ? ` (sessions: ${labels.join(", ")})` : ""}`);
}

async function tmuxAttach(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length > 1) throw new UsageError("usage: xclaude tmux attach [<label>]");
  const tmux = new Tmux(ctx.env);
  const sessions = listSessions(tmux);
  const [label] = args;
  if (label !== undefined) return attachTo(ctx, tmux, requireSession(sessions, label).id);
  if (!sessions.length) throw noSessions();
  if (!ctx.tty.stdin || !ctx.tty.stderr) throw new UsageError(`label required: xclaude tmux attach <label> (sessions: ${sessions.map((s) => s.label).join(", ")})`);
  const items = sessions.map((s) => ({
    label: s.label,
    detail: [s.account ?? "empty", tildify(s.dir, ctx.paths.home), s.attached ? "attached" : ""].filter(Boolean).join(" · "),
  }));
  const index = await pick("Attach to tmux session", items, 0);
  return attachTo(ctx, tmux, sessions[index]!.id);
}

/** "14:03" today, "2026-09-25 14:03" before. */
export function formatCreated(unixSeconds: number, now: Date = new Date()): string {
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

async function tmuxLs(ctx: Ctx, config: Config, args: string[]): Promise<number> {
  if (args.length) throw new UsageError("usage: xclaude tmux ls");
  const tmux = new Tmux(ctx.env);
  const sessions = listSessions(tmux);
  if (!sessions.length) {
    ctx.io.out("No xclaude tmux sessions. Start one with: xclaude tmux new <label> [<account>]\n");
    return EXIT_OK;
  }
  const claude = await claudeStates(ctx, config, tmux, sessions);
  const rows = sessions.map((s) => [
    s.label,
    s.account ?? DASH,
    tildify(s.dir, ctx.paths.home),
    s.attached ? "yes" : "no",
    formatCreated(s.created),
    claude.get(s.id) ?? DASH,
  ]);
  ctx.io.out(formatTable(["LABEL", "ACCOUNT", "WORKDIR", "ATTACHED", "CREATED", "CLAUDE"], rows));
  return EXIT_OK;
}

function tmuxKill(ctx: Ctx, args: string[]): number {
  if (args.length !== 1) throw new UsageError("usage: xclaude tmux kill <label>");
  const tmux = new Tmux(ctx.env);
  const s = requireSession(listSessions(tmux), args[0]!);
  tmux.must(["kill-session", "-t", s.id]);
  ctx.io.err(`xclaude: ended tmux session "${s.label}"\n`);
  return EXIT_OK;
}

export async function tmuxCommand(ctx: Ctx, config: Config, args: string[]): Promise<number> {
  const [sub = "ls", ...rest] = args;
  switch (sub) {
    case "new":
      return tmuxNew(ctx, config, rest);
    case "attach":
      return tmuxAttach(ctx, rest);
    case "ls":
      return tmuxLs(ctx, config, rest);
    case "kill":
      return tmuxKill(ctx, rest);
    default:
      throw new UsageError(`tmux: unknown subcommand "${sub}" (new, attach, ls, kill)`);
  }
}

/** For rm: the labels of an account's sessions, or none when tmux isn't there. */
export function accountSessionLabels(ctx: Ctx, account: string): string[] {
  try {
    return listSessions(new Tmux(ctx.env))
      .filter((s) => s.account === account)
      .map((s) => s.label);
  } catch {
    return [];
  }
}
