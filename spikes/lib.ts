// Infrastructure for the spike suite: a scratch machine, the
// release tarball installed into a scratch npm prefix, and helpers to drive
// xclaude, Claude Code's print mode, its UI (through tmux) and the owner.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Status = "pass" | "fail" | "decide" | "manual" | "skip" | "pending";

export interface SpikeResult {
  id: number;
  title: string;
  status: Status;
  evidence: string[];
}

export interface Options {
  fake: boolean;
  only: number[] | null;
  with: number[];
  keep: boolean;
  tarball: string | null;
  claude: string | null;
}

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** A yes/no question on the owner's terminal, read synchronously from /dev/tty. */
export function askTerminal(question: string): boolean {
  fs.writeSync(2, `\n❓ ${question} [y/n] `);
  const fd = fs.openSync("/dev/tty", "r");
  try {
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    return /^y/i.test(buf.subarray(0, n).toString().trim());
  } finally {
    fs.closeSync(fd);
  }
}

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // next
    }
  }
  return null;
}

export class Suite {
  readonly opts: Options;
  readonly runId = crypto.randomBytes(3).toString("hex");
  readonly root: string;
  readonly home: string;
  readonly store: string;
  readonly xhome: string;
  readonly prefix: string;
  readonly tmuxTmp: string;
  readonly work: { w1: string; w2: string; w3: string; outside: string };
  readonly results: SpikeResult[] = [];
  readonly notes: string[] = [];
  claude = "";
  claudeVersion = "";
  xclaude = "";
  env: Record<string, string> = {};

  constructor(opts: Options) {
    this.opts = opts;
    this.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xclaude-spikes-")));
    this.home = path.join(this.root, "home");
    this.store = path.join(this.home, ".claude");
    this.xhome = path.join(this.home, ".xclaude");
    this.prefix = path.join(this.root, "prefix");
    this.tmuxTmp = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "xcs-"));
    const w = (rel: string) => path.join(this.home, "work", `${rel}-${this.runId}`);
    this.work = { w1: w("w1"), w2: w("w2"), w3: w("w3"), outside: path.join(this.root, "outside", `w-${this.runId}`) };
    // From the start, tmux only ever sees the scratch socket dir: even a failed
    // setup must never reach the owner's own tmux server.
    this.env = { TMUX_TMPDIR: this.tmuxTmp, PATH: "/usr/bin:/bin", HOME: this.home };
  }

  say(text: string): void {
    fs.writeSync(2, `${text}\n`);
  }

  ask(question: string, fakeAnswer = true): boolean {
    if (this.opts.fake) return fakeAnswer;
    return askTerminal(question);
  }

  /** Builds and installs the release tarball, prepares the scratch home and environment. */
  setup(): void {
    for (const dir of [this.home, ...Object.values(this.work)]) fs.mkdirSync(dir, { recursive: true });
    // Pane shells skip login profiles, which could reset PATH (Debian) or reorder it (macOS path_helper).
    fs.writeFileSync(path.join(this.home, ".tmux.conf"), 'set -g default-command "exec /bin/bash --noprofile --norc"\n');
    // macOS finds the login keychain under $HOME; without it, a login in the scratch home makes
    // macOS offer to create a new keychain. The link lets Claude Code keep the test logins in
    // the owner's login keychain, as it would for real accounts (spike 8); the run removes them.
    const keychains = path.join(os.homedir(), "Library", "Keychains");
    if (process.platform === "darwin" && !this.opts.fake && fs.existsSync(keychains)) {
      fs.mkdirSync(path.join(this.home, "Library"), { recursive: true });
      fs.symlinkSync(keychains, path.join(this.home, "Library", "Keychains"));
      this.notes.push("the scratch home links the real Library/Keychains, so the test logins live in the login keychain until the run removes them");
    }
    let tarball = this.opts.tarball;
    if (!tarball) {
      this.say("Building and packing xclaude…");
      // prepack builds dist/ first.
      const out = execFileSync("npm", ["pack", "--json", "--pack-destination", this.root], { cwd: repo, encoding: "utf8" });
      tarball = path.join(this.root, (JSON.parse(out) as Array<{ filename: string }>)[0]!.filename);
    }
    execFileSync("npm", ["install", "-g", "--prefix", this.prefix, "--cache", path.join(this.root, "npm-cache"), "--no-audit", "--no-fund", tarball], {
      stdio: "ignore",
    });
    this.xclaude = path.join(this.prefix, "bin", "xclaude");
    this.notes.push(`xclaude installed from ${path.basename(tarball)} into a scratch npm prefix`);

    if (this.opts.fake) this.claude = path.join(repo, "test", "fake-claude", "claude.mjs");
    else {
      const found = this.opts.claude ?? which("claude");
      if (!found) throw new Error("claude isn't on PATH; pass --claude <path>");
      this.claude = fs.realpathSync(found);
    }
    const tmux = which("tmux");
    const pathDirs = [path.join(this.prefix, "bin"), path.dirname(process.execPath), path.dirname(this.claude)];
    if (tmux) pathDirs.push(path.dirname(tmux));
    this.env = {
      HOME: this.home,
      PATH: [...pathDirs, "/usr/bin", "/bin"].join(":"),
      TERM: process.env.TERM || "xterm-256color",
      LANG: process.env.LANG || (process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8"),
      SHELL: "/bin/bash",
      TMUX_TMPDIR: this.tmuxTmp,
      DISABLE_AUTOUPDATER: "1",
      XCLAUDE_CLAUDE_PATH: this.claude,
      ...(process.env.USER ? { USER: process.env.USER } : {}),
      ...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
      ...(this.opts.fake ? { FAKE_CLAUDE_CONVERSE: "1", FAKE_CLAUDE_LOG: path.join(this.root, "fake.jsonl") } : {}),
    };
    this.claudeVersion = this.run(this.claude, ["--version"]).stdout.trim();
  }

  run(file: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string } = {}): Run {
    const started = performance.now();
    const res = spawnSync(file, args, {
      cwd: opts.cwd ?? this.home,
      env: { ...this.env, ...opts.env },
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 300_000,
      input: opts.input ?? "",
    });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", ms: performance.now() - started };
  }

  xc(args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Run {
    return this.run(this.xclaude, args, opts);
  }

  /** When the last interactive child ended: a Ctrl-C meant for it arrives just after. */
  lastInteractiveEnd = 0;

  /** Runs xclaude in the owner's terminal (for logins). */
  xcInteractive(args: string[], env: Record<string, string> = {}): number | null {
    try {
      return spawnSync(this.xclaude, args, { cwd: this.work.w1, env: { ...this.env, ...env }, stdio: this.opts.fake ? "ignore" : "inherit" }).status;
    } finally {
      this.lastInteractiveEnd = Date.now();
    }
  }

  /** A print-mode prompt with the cheapest model; the JSON result gives the session id. */
  prompt(account: string, text: string, opts: { cwd: string; extra?: string[]; debugFile?: string }): { sessionId: string | null; text: string; run: Run } {
    const args = [account, "-p", text, "--model", "haiku", "--output-format", "json", ...(opts.extra ?? [])];
    if (opts.debugFile) args.push("--debug-file", opts.debugFile);
    const run = this.xc(args, { cwd: opts.cwd });
    try {
      const json = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as { session_id?: string; result?: string };
      return { sessionId: json.session_id ?? null, text: json.result ?? "", run };
    } catch {
      return { sessionId: null, text: run.stdout.trim(), run };
    }
  }

  accountDir(name: string): string {
    return path.join(this.xhome, "accounts", name);
  }

  /** Marks folders trusted for an account, so interactive sessions skip the trust dialog. */
  trust(account: string, dirs: string[]): void {
    const file = path.join(this.accountDir(account), ".claude.json");
    let json: { projects?: Record<string, Record<string, unknown>> } = {};
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // a fresh file
    }
    json.projects ??= {};
    for (const d of dirs) json.projects[d] = { ...json.projects[d], hasTrustDialogAccepted: true };
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
  }

  // ---- the UI, through xclaude's own tmux sessions on the scratch server ----

  tmux(args: string[]): Run {
    return this.run("tmux", args);
  }

  /** Starts `xclaude <account> [args]` in a detached tmux session; returns its target. */
  startUi(label: string, account: string, cwd: string, args: string[] = []): string {
    const res = this.xc(["tmux", "new", label, "--detach", "--dir", cwd, account, "--model", "haiku", ...args]);
    if (res.status !== 0) throw new Error(`tmux new ${label} failed: ${res.stderr.trim()}`);
    return `=xclaude-${account}_${label}:`;
  }

  screen(target: string, scrollback = 0): string {
    return this.tmux(["capture-pane", "-p", "-J", ...(scrollback ? ["-S", `-${scrollback}`] : []), "-t", target]).stdout;
  }

  async waitScreen(target: string, re: RegExp, timeoutMs = 90_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = this.screen(target, 400);
      if (re.test(s)) return s;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${re} in ${target}; last screen:\n${s.trim().split("\n").slice(-15).join("\n")}`);
      await sleep(500);
    }
  }

  /**
   * Waits until Claude Code's prompt is ready. The trust dialog (whose default
   * is "No, exit") is answered with "Yes, I trust this folder": the scratch
   * folders are ours. "? for shortcuts" only shows when no other hint does, so
   * a stable screen with the input box counts too.
   */
  async waitReady(target: string, timeoutMs = 120_000): Promise<string> {
    const started = Date.now();
    let last = "";
    let stable = 0;
    for (;;) {
      const s = this.screen(target);
      if (/Yes, I trust this folder/.test(s)) {
        this.key(target, "1");
        await sleep(1500);
        if (/Yes, I trust this folder/.test(this.screen(target))) {
          this.key(target, "Up");
          this.key(target, "Enter");
        }
        await sleep(1500);
        continue;
      }
      if (/for shortcuts|shift\+tab to|⏵⏵|accept edits on|plan mode on|bypass permissions on/i.test(s)) return s;
      stable = s === last && /[╭╰]─{3,}|^\s*[>❯]\s/m.test(s) ? stable + 1 : 0;
      last = s;
      if (stable >= 6 && Date.now() - started > 5000) return s;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Claude Code didn't become ready in ${target}; last screen:\n${s.trim().split("\n").slice(-15).join("\n")}`);
      }
      await sleep(500);
    }
  }

  /** Types text into Claude's prompt box and submits it, once the text shows in the box. */
  async type(target: string, text: string): Promise<void> {
    await sleep(500);
    this.tmux(["send-keys", "-t", target, "-l", "--", text]);
    const probe = text.slice(0, 20);
    for (let i = 0; i < 25 && !this.screen(target).includes(probe); i++) await sleep(200);
    await sleep(300);
    this.tmux(["send-keys", "-t", target, "Enter"]);
  }

  key(target: string, ...keys: string[]): void {
    this.tmux(["send-keys", "-t", target, ...keys]);
  }

  /** The pid of the program running in a pane's shell (claude, after exec). */
  panePid(target: string): number | null {
    const shell = Number(this.tmux(["display-message", "-p", "-t", target, "#{pane_pid}"]).stdout.trim());
    const out = spawnSync("pgrep", ["-P", String(shell)], { encoding: "utf8" }).stdout.trim().split("\n")[0];
    return out ? Number(out) : null;
  }

  /**
   * Ends a session and waits until its processes are gone. Claude Code takes a few seconds
   * to exit after the hangup and keeps writing to its config dir meanwhile, so a spike that
   * then moves that dir away would race with it. Each pane is its own session, led by its shell.
   */
  killUi(target: string): void {
    const sid = this.tmux(["display-message", "-p", "-t", target, "#{pane_pid}"]).stdout.trim();
    this.tmux(["kill-session", "-t", target.replace(/:$/, "")]);
    if (!/^\d+$/.test(sid)) return;
    const host = { env: { PATH: "/usr/bin:/bin" }, stdio: "ignore" } as const;
    const alive = () => spawnSync("pgrep", ["-s", sid], host).status === 0;
    for (let i = 0; i < 200 && alive(); i++) sleepSync(100);
    if (alive()) {
      spawnSync("pkill", ["-KILL", "-s", sid], host);
      for (let i = 0; i < 50 && alive(); i++) sleepSync(100);
    }
  }

  // ---- results ----

  /** Where the report is written (after every spike, so an interrupted run keeps its results). */
  reportFile = "";

  record(id: number, title: string, status: Status, evidence: string[]): void {
    this.results.push({ id, title, status, evidence });
    const mark = { pass: "✓", fail: "✗", decide: "⚑", manual: "?", skip: "–", pending: "…" }[status];
    this.say(`${mark} spike ${id}: ${title} — ${status}`);
    this.saveReport();
  }

  saveReport(): void {
    if (!this.reportFile) return;
    fs.mkdirSync(path.dirname(this.reportFile), { recursive: true });
    fs.writeFileSync(this.reportFile, this.report());
  }

  report(): string {
    const lines = [
      `# Spike run ${localDate()} on ${process.platform} (${os.release()})`,
      "",
      `- Claude Code: ${this.claudeVersion || "unknown"}${this.opts.fake ? " (fake claude: a rehearsal, not a result)" : ""}`,
      `- Node: ${process.versions.node}; run id ${this.runId}; scratch root ${this.root}`,
      ...this.notes.map((n) => `- ${n}`),
      "",
      "| Spike | Status |",
      "|---|---|",
      ...this.results.map((r) => `| ${r.id}. ${r.title} | ${r.status} |`),
      "",
    ];
    for (const r of this.results) {
      lines.push(`## Spike ${r.id}: ${r.title} — ${r.status}`, "");
      for (const e of r.evidence) lines.push(e.includes("\n") ? `\`\`\`\n${e.trim()}\n\`\`\`` : `- ${e}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * Stops the scratch tmux server (only ever through the scratch socket dir)
   * and removes the scratch folder, unless --keep is given or a spike needs a
   * decision: then the evidence stays, minus the scratch logins' credentials.
   */
  cleanup(): void {
    spawnSync("tmux", ["kill-server"], { env: { TMUX_TMPDIR: this.tmuxTmp, PATH: this.env.PATH || "/usr/bin:/bin" }, stdio: "ignore" });
    const problems = this.results.some((r) => r.status === "fail" || r.status === "decide");
    if (this.opts.keep || (problems && !this.opts.fake)) {
      for (const f of filesNamed(this.root, ".credentials.json")) fs.rmSync(f, { force: true });
      if (!this.opts.keep) this.say(`Kept the scratch folder for the spikes that need attention: ${this.root} (credentials removed; delete it when done)`);
    } else {
      removeTree(this.root);
    }
    removeTree(this.tmuxTmp);
  }
}

/** rmSync, retried for up to 2 s while sessions in the killed panes still write their last lines. */
function removeTree(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 40) throw e;
      sleepSync(50);
    }
  }
}

/** Blocks the thread, for waits inside synchronous cleanup. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Files under dir whose text contains needle (skipping big ones). */
export function filesContaining(dir: string, needle: string, maxBytes = 5_000_000): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          if (fs.statSync(p).size <= maxBytes && fs.readFileSync(p, "utf8").includes(needle)) hits.push(p);
        } catch {
          // unreadable
        }
      }
    }
  };
  walk(dir);
  return hits;
}

/** A listing of a directory tree (names only), for before/after comparisons. */
export function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(e.isDirectory() ? `${r}/` : r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, "");
  return out;
}

/** Today as YYYY-MM-DD in local time. */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Every file with the given name under dir. */
export function filesNamed(dir: string, name: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === name) out.push(p);
    }
  };
  walk(dir);
  return out;
}
