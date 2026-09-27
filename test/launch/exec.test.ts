// Exec: execve replaces the process; the spawn fallback
// mirrors the child's exit and forwards signals.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { XError } from "../../src/core/errors.ts";
import { directlyExecutable, isShellScript, makeExec } from "../../src/launch/exec.ts";
import { fakeClaude } from "../helpers/sandbox.ts";
import { removeTemp, tempDir } from "../helpers/tmp.ts";

const runner = fileURLToPath(new URL("../helpers/run-exec.ts", import.meta.url));

let root: string;
let log: string;
beforeEach(() => {
  root = tempDir();
  log = path.join(root, "calls.jsonl");
});
afterEach(() => removeTemp(root));

interface Run {
  pid: number;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(sig: NodeJS.Signals): void;
}

function start(mode: "spawn" | "execve", extraEnv: Record<string, string> = {}, args: string[] = []): Run {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", runner, mode, fakeClaude, ...args], {
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, FAKE_CLAUDE_LOG: log, ...extraEnv },
    stdio: "ignore",
  });
  return {
    pid: child.pid!,
    done: new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))),
    kill: (sig) => child.kill(sig),
  };
}

function calls(): Array<{ argv: string[]; pid: number; event?: string; signal?: string }> {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function waitFor(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("execve", () => {
  it("replaces the process: claude runs with xclaude's pid and every argument", async () => {
    const run = start("execve", {}, ["-p", "two words", "--add-dir=/a b"]);
    const { code } = await run.done;
    assert.equal(code, 0);
    const [call] = calls();
    assert.equal(call!.pid, run.pid, "same process");
    assert.deepEqual(call!.argv, ["-p", "two words", "--add-dir=/a b"]);
  });

  it("refuses a file that isn't executable, before trying", async () => {
    const file = path.join(root, "not-exec");
    fs.writeFileSync(file, "");
    await assert.rejects(makeExec({ spawnFallback: false })(file, [file], {}), (e: unknown) => e instanceof XError && /isn't executable/.test(e.message));
  });
});

describe("what execve may run", () => {
  it("runs binaries and scripts whose interpreter exists; the rest goes through a spawn", () => {
    assert.equal(directlyExecutable(process.execPath), true, "the node binary");
    const script = (name: string, text: string) => {
      const p = path.join(root, name);
      fs.writeFileSync(p, text, { mode: 0o755 });
      return p;
    };
    assert.equal(directlyExecutable(script("ok", "#!/bin/sh\nexit 0\n")), true);
    assert.equal(directlyExecutable(script("env", "#!/usr/bin/env node\n")), true);
    assert.equal(directlyExecutable(script("missing", "#!/nonexistent/interp\n")), false);
    assert.equal(directlyExecutable(script("bare", "echo hi\n")), false);
    assert.equal(directlyExecutable(path.join(root, "absent")), false);
    // The kernel keeps a \r in the interpreter's name (a script saved with CRLF), and
    // macOS refuses a script as an interpreter: both would make execve fail.
    assert.equal(directlyExecutable(script("crlf", "#!/bin/sh\r\nexit 0\r\n")), false);
    assert.equal(directlyExecutable(script("nested", `#!${path.join(root, "ok")}\n`)), false);
    // What sh runs instead: text without #!.
    assert.equal(isShellScript(path.join(root, "bare")), true);
    assert.equal(isShellScript(path.join(root, "ok")), false);
    assert.equal(isShellScript(process.execPath), false);
    assert.equal(isShellScript(script("nul", "a\0b")), false);
  });

  it("runs a script without #! (as shells do) instead of aborting", async () => {
    const out = path.join(root, "ran");
    const file = path.join(root, "noshebang");
    fs.writeFileSync(file, `echo ran > ${out}\n`, { mode: 0o755 });
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", runner, "execve", file], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(out, "utf8").trim(), "ran");
  });
});

describe("files execve can't run", () => {
  it("runs a CRLF script through the spawn fallback instead of aborting", async () => {
    const file = path.join(root, "crlf");
    fs.writeFileSync(file, "#!/bin/sh\r\nexit 0\r\n", { mode: 0o755 });
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", runner, "execve", file], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    const res = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    assert.equal(res.signal, null, "no abort");
    assert.match(stderr, /couldn't start .*crlf/);
  });

  it("refuses an empty file", async () => {
    const file = path.join(root, "empty");
    fs.writeFileSync(file, "", { mode: 0o755 });
    await assert.rejects(makeExec({ spawnFallback: false })(file, [file], {}), (e: unknown) => e instanceof XError && /is empty, so there's nothing to run/.test(e.message));
  });
});

describe("spawn fallback", () => {
  it("exits with the child's exit code", async () => {
    const run = start("spawn", { FAKE_CLAUDE_EXIT: "7" }, ["x"]);
    assert.deepEqual(await run.done, { code: 7, signal: null });
    assert.notEqual(calls()[0]!.pid, run.pid, "a separate process");
  });

  it("re-raises the signal that ended the child", async () => {
    const run = start("spawn", { FAKE_CLAUDE_WAIT: "1" });
    await waitFor(() => calls().some((c) => c.event === "ready"));
    process.kill(calls().find((c) => c.event === "ready")!.pid, "SIGKILL");
    assert.deepEqual(await run.done, { code: null, signal: "SIGKILL" });
  });

  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    it(`forwards ${sig} to the child`, async () => {
      const run = start("spawn", { FAKE_CLAUDE_WAIT: "1" });
      await waitFor(() => calls().some((c) => c.event === "ready"));
      run.kill(sig);
      assert.deepEqual(await run.done, { code: null, signal: sig });
      assert.ok(calls().some((c) => c.event === "signal" && c.signal === sig), "the child received it");
    });
  }

  it("ignores SIGINT itself and leaves it to the child", async () => {
    const run = start("spawn", { FAKE_CLAUDE_WAIT: "1" });
    await waitFor(() => calls().some((c) => c.event === "ready"));
    run.kill("SIGINT"); // only the parent gets it here; a terminal would signal both
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!calls().some((c) => c.event === "signal"), "the child wasn't signalled");
    run.kill("SIGTERM");
    assert.deepEqual(await run.done, { code: null, signal: "SIGTERM" });
  });
});
