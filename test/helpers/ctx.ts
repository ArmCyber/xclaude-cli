// An in-process Ctx for unit tests: temp paths, captured output, recorded execs.
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, type Config, saveConfig } from "../../src/core/config.ts";
import { memoryIo } from "../../src/core/io.ts";
import { type Paths, resolvePaths } from "../../src/core/paths.ts";
import type { Ctx } from "../../src/ctx.ts";
import { SWITCHES, type Switches } from "../../src/switches.ts";
import { fakeClaude, fixtures } from "./sandbox.ts";
import { removeTemp, tempDir } from "./tmp.ts";

export interface ExecCall {
  file: string;
  argv: string[];
  env: Record<string, string>;
}

export interface TestCtx extends Ctx {
  io: ReturnType<typeof memoryIo>;
  execs: ExecCall[];
  root: string;
  paths: Paths;
  claude: string;
  /** Writes the config (the defaults plus the given accounts). */
  setConfig(change: (c: Config) => void): Config;
  cleanup(): void;
}

export function testCtx(opts: { env?: Record<string, string>; switches?: Partial<Switches>; cwd?: string } = {}): TestCtx {
  const root = tempDir("xclaude-ctx-");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const claude = path.join(bin, "claude");
  fs.symlinkSync(fakeClaude, claude);
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    XCLAUDE_CLAUDE_PATH: claude,
    FAKE_CLAUDE_HELP: path.join(fixtures, "claude-help.txt"),
    FAKE_CLAUDE_LOG: path.join(root, "fake-claude.jsonl"),
    ...opts.env,
  };
  const paths = resolvePaths(env);
  const execs: ExecCall[] = [];
  const ctx: TestCtx = {
    env,
    cwd: opts.cwd ?? home,
    paths,
    io: memoryIo(),
    tty: { stdin: false, stdout: false, stderr: false },
    switches: { ...SWITCHES, ...opts.switches },
    exec: async (file, argv, execEnv) => {
      execs.push({ file, argv, env: execEnv });
      return 0;
    },
    selfPath: null,
    execs,
    root,
    claude,
    setConfig(change) {
      const c = defaultConfig();
      change(c);
      saveConfig(paths, c);
      return c;
    },
    cleanup: () => removeTemp(root),
  };
  return ctx;
}
