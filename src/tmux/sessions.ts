// xclaude's tmux sessions. tmux is the only record: sessions are
// found by the @xclaude=1 option, never by name, so renaming one breaks nothing.
import { XError } from "../core/errors.ts";
import { isNoServer, type Tmux } from "./client.ts";

export const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface XSession {
  id: string;
  label: string;
  /** null for --empty sessions. */
  account: string | null;
  dir: string;
  attached: number;
  /** Unix seconds. */
  created: number;
}

// tmux escapes control characters in format output, so the separator is a
// printable one that ids, numbers, labels and account names can't contain; the
// directory, which can contain anything, comes last.
const SEP = "|";
const FORMAT = ["#{session_id}", "#{@xclaude}", "#{session_attached}", "#{session_created}", "#{@xclaude_label}", "#{@xclaude_account}", "#{@xclaude_dir}"].join(SEP);

/** The session name: xclaude-<account>_<label>, or xclaude--<label> for --empty. `_` can't be in account names, so names never collide. */
export function sessionName(account: string | null, label: string): string {
  return account ? `xclaude-${account}_${label}` : `xclaude--${label}`;
}

export function listSessions(tmux: Tmux): XSession[] {
  const res = tmux.run(["list-sessions", "-F", FORMAT]);
  if (res.code !== 0) {
    if (isNoServer(res.stderr)) return [];
    throw new XError(`tmux list-sessions failed: ${res.stderr.trim()}`);
  }
  const sessions: XSession[] = [];
  for (const line of res.stdout.split("\n")) {
    const parts = line.split(SEP);
    if (parts.length < 7 || parts[1] !== "1") continue;
    const [id = "", , attached = "0", created = "0", label = "", account = "", ...dir] = parts;
    sessions.push({ id, label, account: account || null, dir: dir.join(SEP), attached: Number(attached), created: Number(created) });
  }
  return sessions.sort((a, b) => a.label.localeCompare(b.label));
}

export function findByLabel(sessions: XSession[], label: string): XSession | undefined {
  return sessions.find((s) => s.label === label);
}

