// Output goes through synchronous writes: output printed right before exec
// would be lost with Node's asynchronous pipe writes.
import fs from "node:fs";
import { sleepSync } from "./sleep.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text);
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(fd, buf, offset);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        sleepSync(2);
        continue;
      }
      if (code === "EPIPE") return; // e.g. `xclaude ls | head -1`
      throw e;
    }
  }
}

export const stdio: Io = {
  out: (text) => writeAll(1, text),
  err: (text) => writeAll(2, text),
};

/** An Io that keeps everything in memory, for tests. */
export function memoryIo(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: "",
    stderr: "",
    out(text: string) {
      io.stdout += text;
    },
    err(text: string) {
      io.stderr += text;
    },
  };
  return io;
}
