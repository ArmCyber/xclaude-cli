// The account picker, also used to pick tmux sessions. A pure state
// machine plus a raw-mode renderer on stderr.
import fs from "node:fs";
import tty from "node:tty";
import { Cancelled, UsageError } from "../core/errors.ts";
import type { State } from "../core/state.ts";

export interface PickerItem {
  label: string;
  detail?: string;
}

export type Key = "up" | "down" | "enter" | "cancel" | { jump: number } | null;

/** Turns raw terminal input into keys: arrows, j/k, 1–9, Enter, Esc, Ctrl-C. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const rest = chunk.slice(i);
    if (rest.startsWith("\x1b[A") || rest.startsWith("\x1bOA")) {
      keys.push("up");
      i += 3;
    } else if (rest.startsWith("\x1b[B") || rest.startsWith("\x1bOB")) {
      keys.push("down");
      i += 3;
    } else if (rest.startsWith("\x1b[")) {
      // Some other control sequence: skip to its final byte.
      let j = 2;
      while (j < rest.length && !/[@-~]/.test(rest[j]!)) j++;
      keys.push(null);
      i += j + 1;
    } else {
      const c = rest[0]!;
      if (c === "\x1b") keys.push(rest.length === 1 ? "cancel" : null); // a lone Esc
      else if (c === "\x03") keys.push("cancel");
      else if (c === "\r" || c === "\n") keys.push("enter");
      else if (c === "k") keys.push("up");
      else if (c === "j") keys.push("down");
      else if (c >= "1" && c <= "9") keys.push({ jump: Number(c) - 1 });
      else keys.push(null);
      i++;
    }
  }
  return keys;
}

export type Step = { index: number; done?: "chosen" | "cancelled" };

/** One key applied to the selection. Up and down wrap around. */
export function step(index: number, count: number, key: Key): Step {
  if (key === "up") return { index: (index - 1 + count) % count };
  if (key === "down") return { index: (index + 1) % count };
  if (key === "enter") return { index, done: "chosen" };
  if (key === "cancel") return { index, done: "cancelled" };
  if (key && typeof key === "object" && key.jump < count) return { index: key.jump };
  return { index };
}

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

function fit(text: string, width: number): string {
  return width > 0 && text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

/** The lines of one frame, without trailing newlines. Colors only apply to whole parts, so fitting stays simple. */
export function render(title: string, items: PickerItem[], index: number, width = 0): string[] {
  const labelWidth = Math.max(...items.map((it) => it.label.length));
  const lines = [bold(fit(title, width))];
  items.forEach((it, i) => {
    const marker = i === index ? "❯" : " ";
    const num = i < 9 ? String(i + 1) : " ";
    const label = it.label.padEnd(labelWidth);
    const text = fit(`${marker} ${num}  ${label}${it.detail ? `  ${it.detail}` : ""}`, width);
    const head = text.slice(0, 5 + labelWidth);
    const tail = text.slice(5 + labelWidth);
    lines.push(i === index ? `${bold(head)}${dim(tail)}` : `${head}${dim(tail)}`);
  });
  lines.push(dim(fit("↑/↓ or j/k to move · 1–9 to jump · Enter to choose · Esc to cancel", width)));
  return lines;
}

/** Preselection: the account last used in this directory, else the most recently used one, else the first. */
export function preselect(names: string[], state: State, cwd: string): number {
  for (const candidate of [state.lastAccountByDir[cwd], state.lastUsedAccount]) {
    if (candidate && names.includes(candidate)) return names.indexOf(candidate);
  }
  return 0;
}

/**
 * The keyboard, read from a separate descriptor on /dev/tty. Node puts a terminal
 * it reads from into non-blocking mode, and claude inherits fds 0–2 through
 * exec, so the picker never touches process.stdin.
 */
function openKeyboard(): { input: tty.ReadStream; columns: number; close: () => void } {
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r");
  } catch {
    // Reading process.stdin would leave fd 0 non-blocking for claude.
    throw new UsageError("account required: there's no terminal to show the picker on (xclaude <account> [claude args…])");
  }
  const input = new tty.ReadStream(fd);
  // The width comes from this handle: a tty.WriteStream would disturb fd 2 when destroyed.
  let columns = 0;
  try {
    const size: number[] = [];
    const handle = (input as unknown as { _handle?: { getWindowSize?(out: number[]): number } })._handle;
    if (handle?.getWindowSize?.(size) === 0) columns = size[0] ?? 0;
  } catch {
    // no width: lines aren't shortened
  }
  // Not destroy(): Node's socket teardown compares against process.stderr, which
  // creates stderr and reopens fd 2. Its descriptors are close-on-exec anyway.
  return {
    input,
    columns,
    close: () => {
      input.pause();
      input.unref();
    },
  };
}

/**
 * Shows the picker on stderr and resolves with the chosen index; throws
 * Cancelled on Esc or Ctrl-C. The terminal is always restored from raw mode
 * before this returns, since claude may replace the process right after.
 */
export function pick(title: string, items: PickerItem[], initial: number): Promise<number> {
  const keyboard = openKeyboard();
  const { input } = keyboard;
  const write = (s: string) => fs.writeSync(2, s);
  let index = Math.min(Math.max(initial, 0), items.length - 1);
  let drawn = 0;
  const draw = () => {
    const lines = render(title, items, index, keyboard.columns);
    write(`${drawn ? `\r\x1b[${drawn}A` : ""}\x1b[J${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve, reject) => {
    const finish = (result: "chosen" | "cancelled") => {
      input.off("data", onData);
      try {
        input.setRawMode(false);
      } finally {
        keyboard.close();
        write(`\r\x1b[${drawn}A\x1b[J\x1b[?25h`); // erase the picker, show the cursor
      }
      if (result === "chosen") resolve(index);
      else reject(new Cancelled());
    };
    const onData = (chunk: string) => {
      for (const key of parseKeys(chunk)) {
        const next = step(index, items.length, key);
        index = next.index;
        if (next.done) {
          finish(next.done);
          return;
        }
      }
      draw();
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
    write("\x1b[?25l");
    draw();
  });
}
