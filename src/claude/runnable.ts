// How a file gets started: what execve can run directly, and what a shell would run
// with sh. Shared by the launch, `add`, the claude subcommands and the --help parse.
import fs from "node:fs";
import path from "node:path";
import { isExecutableFile } from "./resolve.ts";

/** The first bytes of a file, or null if it can't be read. */
function readHead(file: string): Buffer | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(256);
      return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

const isBinary = (head: Buffer) =>
  head.length >= 4 &&
  ((head[0] === 0x7f && head.subarray(1, 4).toString("latin1") === "ELF") ||
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(head.readUInt32BE(0)));

const hasShebang = (head: Buffer) => head[0] === 0x23 && head[1] === 0x21;

/**
 * The #! interpreter, read the way the kernel reads it: after #! and any spaces or
 * tabs, up to the next space, tab or newline. A \r (a script saved with CRLF line
 * endings) stays part of the name, as it does for the kernel.
 */
function interpreterOf(head: Buffer): string {
  const line = head.subarray(2).toString("utf8").split("\n")[0]!;
  return /^[ \t]*([^ \t]*)/.exec(line)![1]!;
}

/**
 * Whether execve can run the file itself: a binary (ELF, Mach-O), or a script whose
 * #! interpreter is an existing binary (macOS refuses a script as an interpreter).
 * Anything else goes through /bin/sh or the spawn fallback: a failed execve aborts
 * Node before v26.1.
 */
export function directlyExecutable(file: string): boolean {
  const head = readHead(file);
  if (!head) return false;
  if (isBinary(head)) return true;
  if (!hasShebang(head)) return false;
  const interpreter = interpreterOf(head);
  const interpreterHead = path.isAbsolute(interpreter) && isExecutableFile(interpreter) ? readHead(interpreter) : null;
  return interpreterHead !== null && isBinary(interpreterHead);
}

/** A text file without #!, which shells run with sh. */
export function isShellScript(file: string): boolean {
  const head = readHead(file);
  return head !== null && head.length > 0 && !isBinary(head) && !hasShebang(head) && !head.includes(0);
}

/**
 * The file and arguments to start so it runs the way a shell would run it: a text
 * script without #! runs as `/bin/sh <script>` (glibc's execvp does that by itself,
 * macOS's posix_spawn doesn't).
 */
export function shellWay(file: string, args: string[]): [string, string[]] {
  return isShellScript(file) ? ["/bin/sh", [file, ...args]] : [file, args];
}

/** Whether the file is empty: there's nothing to run, whatever its mode. */
export function isEmptyFile(file: string): boolean {
  try {
    return fs.statSync(file).size === 0;
  } catch {
    return false;
  }
}
