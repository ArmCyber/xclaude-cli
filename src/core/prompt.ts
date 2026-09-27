// A yes/no question on the terminal. Reads a line from /dev/tty synchronously,
// so Node's stdin stream is never set up.
import fs from "node:fs";

/** Asks on stderr and reads the answer from the terminal; anything but y/yes is no. */
export function confirm(question: string): boolean {
  fs.writeSync(2, `${question} [y/N] `);
  let fd: number;
  try {
    fd = fs.openSync("/dev/tty", "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    const answer = buf.subarray(0, n).toString("utf8").trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
