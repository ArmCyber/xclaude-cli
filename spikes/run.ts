// The spike suite: xclaude against the real Claude Code, one guided run per machine.
//   node --experimental-strip-types spikes/run.ts [--with 5,14] [--only 1,4] [--fake] [--keep]
//                                                 [--tarball <file>] [--claude <path>]
// Everything runs under a scratch HOME with the release tarball installed into a
// scratch npm prefix and a private tmux server: the real ~/.claude, ~/.xclaude,
// logins and tmux server are never touched (spikes 7 and 11 are the exception,
// after a backup). On macOS the test logins live in the login keychain until the
// run removes them.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesContaining, filesNamed, listTree, localDate, type Options, repo, sleep, Suite } from "./lib.ts";

const HELP = `Usage: node --experimental-strip-types spikes/run.ts [options]

  --with 5,14,7,11   also run these (5 needs two orgs that provision skills; 14 logs
                     out one of two logins of the same user; 7 and 11 use the real
                     home after a backup)
  --only 1,4         run just these spikes
  --fake             rehearse with the fake claude (no logins, no tokens)
  --keep             keep the scratch directory afterwards
  --tarball <file>   install this package instead of packing the repo
  --claude <path>    the claude binary to test (default: the one on PATH)
`;

function parseArgs(argv: string[]): Options {
  const opts: Options = { fake: false, only: null, with: [], keep: false, tarball: null, claude: null };
  const list = (v: string | undefined) => (v ?? "").split(",").map(Number).filter((n) => n > 0);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fake") opts.fake = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--only") opts.only = list(argv[++i]);
    else if (a === "--with") opts.with = list(argv[++i]);
    else if (a === "--tarball") opts.tarball = path.resolve(argv[++i] ?? "");
    else if (a === "--claude") opts.claude = path.resolve(argv[++i] ?? "");
    else {
      process.stdout.write(HELP);
      process.exit(a === "--help" || a === "-h" ? 0 : 2);
    }
  }
  return opts;
}

interface Fixture {
  word: string;
  /** The conversation a started in w1; spikes 6, 1 and 13 continue it. */
  convId: string | null;
}

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const grepLines = (text: string, re: RegExp, max = 8) =>
  text
    .split("\n")
    .filter((l) => re.test(l))
    .slice(0, max);
/** Link trouble in a debug log: only lines about the shared projects/ count. */
const LINK_ERRORS = /(is a (symbolic )?link|ELOOP|EISDIR|ENOTDIR|EXDEV).*projects\/|projects\/.*(is a (symbolic )?link|ELOOP|EISDIR|ENOTDIR|EXDEV)/i;
const tail = (text: string, n: number) => text.trim().split("\n").slice(-n).join("\n");
const READ_SAVED =
  "The output of the most recent seq command in this conversation was too large to show, so it was saved to a file whose path is in that command's result. Use the Read tool on that file with offset 200001 and limit 5, and reply with just the line that starts with END-.";

async function login(s: Suite, name: string, who: string): Promise<boolean> {
  s.say(`\n▶ Account "${name}": Claude Code starts now (scratch home). Log in with /login as ${who}, then quit with /exit.`);
  s.say("  If the browser doesn't open, press c to copy the login URL.");
  const user = name === "a2" ? "a" : name;
  const env: Record<string, string> = s.opts.fake
    ? { FAKE_CLAUDE_LOGIN: JSON.stringify({ email: `${user}@example.com`, orgId: `org-${user}`, orgName: `Org ${user}` }) }
    : {};
  let first = true;
  for (;;) {
    s.xcInteractive(first ? ["add", name] : [name], env);
    first = false;
    if (authOf(s, name).loggedIn) return true;
    if (!s.ask(`"${name}" isn't logged in yet. Try again?`, false)) return false;
  }
}

function authOf(s: Suite, name: string): { loggedIn: boolean; email: string | null } {
  try {
    const j = JSON.parse(s.xc([name, "auth", "status"]).stdout) as { loggedIn?: boolean; email?: string };
    return { loggedIn: Boolean(j.loggedIn), email: j.email ?? null };
  } catch {
    return { loggedIn: false, email: null };
  }
}

/** Starts an interactive session and waits for its prompt; returns the tmux target. */
async function ui(s: Suite, label: string, account: string, cwd: string, args: string[] = []): Promise<string> {
  s.trust(account, [cwd]);
  const t = s.startUi(label, account, cwd, args);
  try {
    await s.waitReady(t);
  } catch (e) {
    s.killUi(t);
    throw e;
  }
  return t;
}

/** Claude Code's Keychain entries on macOS (service names). */
function keychainEntries(): string[] {
  const dump = spawnSync("security", ["dump-keychain"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
  return [...new Set([...dump.matchAll(/"svce"<blob>="(Claude Code[^"]*)"/g)].map((m) => m[1]!))];
}

/** Continue the fixture conversation by id: `-c` would pick whatever ran last in the folder. */
const sameConv = (fx: Fixture) => (fx.convId ? ["-r", fx.convId] : ["-c"]);

/**
 * A large tool output in a's conversation whose last line exists only in the saved output: the
 * command prints a random line from a file the conversation never shows, and the file is removed
 * right after. Returns that line once the saved output is found to end with it.
 */
function largeOutput(s: Suite, fx: Fixture): { line: string | null; note: string } {
  const secret = `END-${crypto.randomBytes(6).toString("hex")}`;
  const file = path.join(s.work.w1, `spike-line-${s.runId}.txt`);
  const command = `seq 1 200000; cat ${path.basename(file)}`;
  const savedFile = () => (fx.convId ? newestFile(path.join(s.store, "projects"), `/${fx.convId}/tool-results/`) : null);
  const done = () => {
    const saved = savedFile();
    return saved !== null && read(saved).trim().split("\n").at(-1) === secret;
  };
  const run = (text: string) =>
    s.prompt("a", text, { cwd: s.work.w1, extra: [...sameConv(fx), "--allowedTools", "Bash(seq:*)", "Bash(cat:*)"] }).text;
  fs.writeFileSync(file, `${secret}\n`);
  const replies: string[] = [];
  try {
    replies.push(run(`Run the shell command \`${command}\` and then reply with just DONE.`));
    // The model sometimes declines a bare "run this"; asked once more with the reason, it runs it.
    if (!done() && !s.opts.fake) {
      replies.push(
        run(`This checks how Claude Code saves a long command output. \`${command}\` only prints numbers and a line from a text file in this folder. Please run it now, then reply with just DONE.`),
      );
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
  const saved = savedFile();
  const ok = done();
  const where = saved ? path.relative(s.store, saved) : "not found";
  const said = replies.map((r) => JSON.stringify(ok ? r.slice(0, 30) : r.slice(0, 300))).join(", then ");
  return { line: ok ? secret : null, note: `a ran the large command (${said}); its saved output: ${where}${saved && !ok ? " (without the expected last line)" : ""}` };
}

/** The most recently written file under dir whose path contains `part`. */
function newestFile(dir: string, part: string): string | null {
  const files = listTree(dir)
    .filter((f) => !f.endsWith("/") && `/${f}`.includes(part))
    .map((f) => path.join(dir, f));
  return files.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0] ?? null;
}

const historyText = (s: Suite) => read(path.join(s.store, "history.jsonl"));

/** Whether an interactive prompt reached the shared history. */
const inHistory = (s: Suite, marker: string) => historyText(s).includes(marker);

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
  return true;
}

/**
 * Types text and checks it was submitted (prompts and slash commands both land in the history).
 * A one-time dialog, like a new-model announcement on an account's first session, can take the
 * keys meant for the prompt: it's dismissed with Escape and the text typed again.
 */
async function submitUntil(s: Suite, t: string, text: string, done: () => boolean): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await s.type(t, text);
    if (await until(done, 20_000)) return true;
    s.key(t, "Escape");
    await sleep(1000);
    s.key(t, "C-u");
    await sleep(500);
  }
  return false;
}

const submit = (s: Suite, t: string, text: string, marker: string) => submitUntil(s, t, text, () => inHistory(s, marker));

/** Runs a slash command in the UI (see submitUntil). */
function command(s: Suite, t: string, cmd: string): Promise<boolean> {
  const count = () => historyText(s).split(`"display":${JSON.stringify(cmd)}`).length;
  const before = count();
  return submitUntil(s, t, cmd, () => count() > before);
}

interface Turn {
  role: string;
  text: string;
  tools: string[];
  errors: number;
}

/** A conversation's turns since a moment (ISO time), from its transcript in the store. */
function turnsSince(s: Suite, sessionId: string, since: string): Turn[] {
  const file = filesNamed(path.join(s.store, "projects"), `${sessionId}.jsonl`)[0];
  const turns: Turn[] = [];
  for (const line of file ? read(file).split("\n") : []) {
    let e: { timestamp?: string; type?: string; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.timestamp ?? "") < since || (e.type !== "user" && e.type !== "assistant")) continue;
    const c = e.message?.content;
    const parts = (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : []) as Array<Record<string, unknown>>;
    turns.push({
      role: e.type,
      text: parts.filter((p) => p.type === "text").map((p) => String(p.text)).join(" "),
      tools: parts.filter((p) => p.type === "tool_use").map((p) => `${String(p.name)} ${JSON.stringify(p.input).slice(0, 160)}`),
      errors: parts.filter((p) => p.type === "tool_result" && p.is_error).length,
    });
  }
  return turns;
}

// ---------------------------------------------------------------------------

async function spike12(s: Suite, fx: Fixture): Promise<void> {
  const debug = path.join(s.root, "debug-12.log");
  const r = s.prompt("a", `Remember the word ${fx.word}. Reply with just OK.`, { cwd: s.work.w1, debugFile: debug });
  fx.convId = r.sessionId;
  const ev = [`first conversation on a: session ${r.sessionId ?? "none"}, reply ${JSON.stringify(r.text.slice(0, 80))}`];
  if (!r.sessionId) return s.record(12, "storage backend", "fail", [...ev, `the prompt failed: ${r.run.stdout.trim()} ${r.run.stderr.trim()}`]);
  const hits = grepLines(read(debug), /storage interface|through the storage|storage-?v2|storage ?backend/i);
  let dataInV2 = false;
  for (const d of [path.join(s.store, "storage-v2"), path.join(s.accountDir("a"), "storage-v2")]) {
    const tree = listTree(d);
    if (tree.length) dataInV2 = true;
    if (fs.existsSync(d)) ev.push(`${d}: ${tree.slice(0, 20).join(", ") || "(empty)"}`);
  }
  if (hits.length) ev.push(`debug log mentions the storage backend:\n${hits.join("\n")}`);
  if (hits.length || dataInV2) {
    return s.record(12, "storage backend", "decide", [
      ...ev,
      "Possibly active: find where it keeps data and locks, then re-check the history merge and the sharing of projects, tasks and teams (go/no-go). The scratch folder is kept for this.",
    ]);
  }
  s.record(12, "storage backend", "pass", [...ev, "no sign of the storage backend in the debug log or storage-v2/"]);
}

async function spike6(s: Suite, fx: Fixture): Promise<void> {
  const ev: string[] = [];
  const dbg = path.join(s.root, "debug-6.log");
  const cont = s.prompt("b", "Which word did I ask you to remember? Reply with just the word.", { cwd: s.work.w1, extra: ["-c"], debugFile: dbg });
  const okContinue = cont.text.includes(fx.word);
  ev.push(`b --continue in w1: ${JSON.stringify(cont.text.slice(0, 80))} (${okContinue ? "has" : "lacks"} the word)`);
  const big = largeOutput(s, fx);
  ev.push(big.note);
  const since = new Date().toISOString();
  const back = s.prompt("b", READ_SAVED, { cwd: s.work.w1, extra: [...sameConv(fx), "--allowedTools", "Read"], debugFile: dbg });
  const okTool = s.opts.fake || (big.line !== null && back.text.includes(big.line));
  ev.push(`b read the saved output's last line: ${JSON.stringify(back.text.slice(0, 60))} (${okTool ? "right" : big.line ? `WRONG, it's ${big.line}` : "couldn't check"})`);
  if (fx.convId) ev.push(`b's tool calls: ${turnsSince(s, fx.convId, since).flatMap((t) => t.tools).join("; ") || "none"}`);
  const linkErrors = grepLines(read(dbg), LINK_ERRORS);
  if (linkErrors.length) ev.push(`link errors about projects/ in the debug log:\n${linkErrors.join("\n")}`);

  // /resume lists interactive conversations only (Claude Code leaves out -p ones, for every
  // account), so a starts one in the UI and b's /resume must list it.
  const probe = `resume-probe-${s.runId}`;
  let uiStatus: "pass" | "manual" = "manual";
  let ta = "";
  let tb = "";
  try {
    ta = await ui(s, "s6a", "a", s.work.w1);
    const sent = await submit(s, ta, `${probe}: reply with just OK`, probe);
    s.killUi(ta);
    ta = "";
    if (!sent) throw new Error("a's prompt didn't reach Claude Code");
    tb = await ui(s, "s6", "b", s.work.w1);
    await command(s, tb, "/resume");
    await sleep(3000);
    const resume = s.screen(tb);
    const listed = resume.includes(probe);
    ev.push(`/resume in b ${listed ? "lists" : "doesn't list"} a's interactive conversation:\n${resume.trim().split("\n").slice(0, 25).join("\n")}`);
    s.key(tb, "Escape");
    await sleep(1000);
    await s.type(tb, "/stats");
    await sleep(5000);
    const stats = s.screen(tb);
    const statsError = /error|failed|ENOENT/i.test(stats);
    ev.push(`/stats in b:\n${tail(stats, 20)}`);
    s.key(tb, "Escape");
    uiStatus = listed && !statsError ? "pass" : "manual";
  } catch (e) {
    ev.push(`the UI check didn't complete: ${(e as Error).message}`);
  } finally {
    if (ta) s.killUi(ta);
    if (tb) s.killUi(tb);
  }
  ev.push("VS Code's conversation history is checked with spike 11 (--with 11, in the real home).");
  const verdict = !okContinue || (!okTool && big.line !== null) || linkErrors.length ? "fail" : okTool ? uiStatus : "manual";
  s.record(6, "linking all of projects/", verdict, ev);
}

async function spike1(s: Suite, fx: Fixture): Promise<void> {
  const ev: string[] = [];
  if (!fx.convId) return s.record(1, "continue on another account", "fail", ["no conversation from spike 12 to continue"]);
  const r = s.prompt("b", "Which word did I ask you to remember? Reply with just the word.", { cwd: s.work.w2, extra: ["-r", fx.convId] });
  const okResume = r.text.includes(fx.word);
  ev.push(`b -r <id> from w2: ${JSON.stringify(r.text.slice(0, 80))} (${okResume ? "has" : "lacks"} the word)`);
  let rewind: "pass" | "manual" = "manual";
  let tasks: "pass" | "manual" = "manual";
  if (s.opts.fake) {
    rewind = "pass";
    tasks = "pass";
  } else {
    // A file edit in an interactive session makes a checkpoint (print mode makes none); b's
    // /rewind should offer to restore it, since file-history is shared.
    const note = `note-${s.runId}.txt`;
    let ta = "";
    try {
      ta = await ui(s, "s1a", "a", s.work.w1, ["-r", fx.convId, "--allowedTools", "Write", "Edit"]);
      await submit(s, ta, `Create the file ${note} containing the single line v1, using your file tools. Reply with just DONE.`, note);
      await until(() => fs.existsSync(path.join(s.work.w1, note)), 90_000);
      await sleep(3000);
    } catch (e) {
      ev.push(`a's edit in the UI didn't complete: ${(e as Error).message}`);
    } finally {
      if (ta) s.killUi(ta);
    }
    const checkpoints = listTree(path.join(s.store, "file-history", fx.convId)).length;
    ev.push(`a edited a file in the UI: ${fs.existsSync(path.join(s.work.w1, note)) ? "yes" : "no"}; the conversation's file-history entries: ${checkpoints}`);
    let t = "";
    try {
      t = await ui(s, "s1", "b", s.work.w1, ["-r", fx.convId]);
      const before = s.screen(t, 400).split(note).length;
      await command(s, t, "/rewind");
      await sleep(3000);
      const screen = s.screen(t, 400);
      // The rewind list repeats a's message, with a warning under it when there's no code to restore.
      const lines = screen.split("\n");
      const item = lines.findLastIndex((l) => l.includes(note));
      const listed = screen.split(note).length > before;
      const restorable = listed && !/No code restore/i.test(lines[item + 1] ?? "");
      rewind = restorable ? "pass" : "manual";
      ev.push(`/rewind in b lists a's message: ${listed ? "yes" : "unclear"}; offers to restore its code: ${restorable ? "yes" : "no"}\n${tail(screen, 25)}`);
      s.key(t, "Escape");
    } catch (e) {
      ev.push(`the /rewind check didn't complete: ${(e as Error).message}`);
    } finally {
      if (t) s.killUi(t);
    }
    // The task list, checked in its files: b completes the task a created.
    const tasksDir = path.join(s.store, "tasks");
    const taskTools = ["--allowedTools", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"];
    s.prompt("a", "Use your task tools to create one task titled probe. Reply with just DONE.", { cwd: s.work.w1, extra: ["-r", fx.convId, ...taskTools] });
    const snapshot = () =>
      listTree(tasksDir)
        .filter((f) => !f.endsWith("/") && !f.endsWith(".lock"))
        .map((f) => `${f}:${read(path.join(tasksDir, f))}`)
        .join("\n");
    const afterA = snapshot();
    s.prompt("b", "Mark every task on your current task list as completed using your task tools. Reply with just DONE.", {
      cwd: s.work.w1,
      extra: ["-r", fx.convId, ...taskTools],
    });
    const afterB = snapshot();
    tasks = afterA && afterB !== afterA && /completed/i.test(afterB) ? "pass" : "manual";
    ev.push(`task files after a: ${afterA ? "present" : "none"}; b completed a's task: ${tasks === "pass" ? "yes" : "unclear"}`);
  }
  s.record(1, "continue on another account", !okResume ? "fail" : rewind === "pass" && tasks === "pass" ? "pass" : "manual", ev);
}

async function spike3(s: Suite): Promise<void> {
  const ev: string[] = [];
  const sessionsDir = path.join(s.store, "sessions");
  const targets: string[] = [];
  try {
    // A throwaway conversation, open under a and then opened again under b.
    const tmp = s.prompt("a", "Reply with just OK.", { cwd: s.work.w3 });
    const ta = await ui(s, "s3a", "a", s.work.w3, tmp.sessionId ? ["-r", tmp.sessionId] : []);
    targets.push(ta);
    s.trust("b", [s.work.w3]);
    const tb = s.startUi("s3b", "b", s.work.w3, tmp.sessionId ? ["-r", tmp.sessionId] : []);
    targets.push(tb);
    await sleep(8000);
    const conflict = s.screen(tb);
    const noticed = /already (open|running|in use)|another (session|process)|in use/i.test(conflict);
    ev.push(`b opening the conversation a has open: ${noticed ? "Claude Code noticed" : "no warning seen"}\n${tail(conflict, 12)}`);
    s.killUi(tb);

    // One agents call, with a fresh b session next to a's.
    const tc = await ui(s, "s3c", "b", s.work.w3);
    targets.push(tc);
    const pidA = s.panePid(ta);
    const pidC = s.panePid(tc);
    const t0 = performance.now();
    const ag = s.xc(["b", "agents", "--json"]);
    const ms = performance.now() - t0;
    let pids: number[] = [];
    try {
      pids = (JSON.parse(ag.stdout) as Array<{ pid?: number }>).map((e) => e.pid ?? 0);
    } catch {
      ev.push(`agents --json output wasn't JSON: ${ag.stdout.slice(0, 200)} ${ag.stderr.slice(0, 200)}`);
    }
    const both = pidA !== null && pidC !== null && pids.includes(pidA) && pids.includes(pidC);
    ev.push(`one \`xclaude b agents --json\` call (${ms.toFixed(0)} ms) lists a's session: ${pidA !== null && pids.includes(pidA)}, b's: ${pidC !== null && pids.includes(pidC)}`);
    for (const n of ["a", "b"]) ev.push(`${n}/daemon ${fs.existsSync(path.join(s.accountDir(n), "daemon")) ? "exists (a supervisor ran)" : "doesn't exist"}`);

    // Crash cleanup must never remove another account's live entry.
    const before = listTree(sessionsDir);
    if (pidC !== null) process.kill(pidC, "SIGKILL");
    await sleep(1000);
    const td = await ui(s, "s3d", "b", s.work.w3);
    targets.push(td);
    await sleep(3000);
    const after = listTree(sessionsDir);
    const aEntry = before.filter((f) => pidA !== null && (f.includes(String(pidA)) || read(path.join(sessionsDir, f)).includes(String(pidA))));
    const aSurvived = aEntry.length > 0 && aEntry.every((f) => after.includes(f));
    ev.push(`sessions/ before b's crash: ${before.join(", ")}; after the next b start: ${after.join(", ")}`);
    ev.push(`a's live entry ${aEntry.length ? (aSurvived ? "survived" : "was REMOVED") : "wasn't found by pid"}`);
    if (!both) ev.push("fallback: make sessions per account and query agents once per account (switches shareSessions off, agentsPerAccount on)");
    s.record(3, "shared sessions/", !both || (aEntry.length > 0 && !aSurvived) ? "fail" : aEntry.length ? "pass" : "manual", ev);
  } catch (e) {
    s.record(3, "shared sessions/", "manual", [...ev, `the UI check didn't complete: ${(e as Error).message}`]);
  } finally {
    for (const t of targets) s.killUi(t);
  }
}

async function spike4(s: Suite): Promise<void> {
  const ev: string[] = [];
  const history = path.join(s.store, "history.jsonl");
  const seen = new Set<string>();
  const watch = setInterval(() => {
    for (const p of [`${history}.lock`, ...["a", "b"].map((n) => path.join(s.accountDir(n), "history.jsonl.lock"))]) if (fs.existsSync(p)) seen.add(p);
  }, 2);
  const targets: string[] = [];
  let undelivered = false;
  let missing = false;
  try {
    for (const n of ["a", "b"]) {
      const t = await ui(s, `s4${n}`, n, s.work.w3);
      targets.push(t);
      const marker = `history-${n}-${s.runId}`;
      if (await submit(s, t, `${marker}: reply with just OK`, marker)) {
        ev.push(`${n}'s prompt is in ~/.claude/history.jsonl`);
      } else if (filesContaining(path.join(s.store, "projects"), marker).length) {
        missing = true;
        ev.push(`${n}'s prompt reached Claude Code (it's in a transcript) but NOT ~/.claude/history.jsonl`);
      } else {
        undelivered = true;
        ev.push(`${n}'s prompt never reached Claude Code (a UI problem, not a history result):\n${tail(s.screen(t), 15)}`);
      }
    }
  } catch (e) {
    undelivered = true;
    ev.push(`the UI check didn't complete: ${(e as Error).message}`);
  } finally {
    clearInterval(watch);
    for (const t of targets) s.killUi(t);
  }
  const links = ["a", "b"].map((n) => {
    const p = path.join(s.accountDir(n), "history.jsonl");
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : "a regular file";
  });
  ev.push(`accounts' history.jsonl: ${links.join(", ")}`);
  ev.push(`lock dirs seen while writing: ${[...seen].join(", ") || "none (too quick to catch)"}`);
  const linked = links.every((l) => l.endsWith("history.jsonl"));
  const accountLock = [...seen].some((p) => p.includes("/accounts/"));
  s.record(4, "history.jsonl link", !linked || accountLock || missing ? "fail" : undelivered ? "manual" : "pass", ev);
}

async function spike2(s: Suite): Promise<void> {
  const ev: string[] = [];
  fs.writeFileSync(path.join(s.store, "CLAUDE.md"), `# spike 2 (${s.runId})\nShared instructions for spike 2.\n`);
  fs.mkdirSync(path.join(s.store, "rules"), { recursive: true });
  const rule = `spike2-${s.runId}.md`;
  fs.writeFileSync(path.join(s.store, "rules", rule), "Rule for spike 2.\n");
  let duplicates = false;
  let unclear = false;
  const counts: Record<string, string> = {};
  const places: Array<[string, string]> = [
    ["outside $HOME", s.work.outside],
    ["under $HOME", s.work.w1],
    ["$HOME itself", s.home],
  ];
  for (const [i, [where, dir]] of places.entries()) {
    let t = "";
    try {
      t = await ui(s, `s2x${i}`, "a", dir);
      // /context folds the list into "N files · T tokens"; the same count everywhere means
      // nothing loads twice. (`/context all` scrolls the memory files out of the capture.)
      await command(s, t, "/context");
      await sleep(5000);
      const screen = s.screen(t, 600);
      const shared = grepLines(screen, /\.claude\/CLAUDE\.md/, 20);
      const rules = grepLines(screen, new RegExp(rule.replace(".", "\\.")), 20);
      const summary = /(\d+) files? · ([\d.]+k?) tokens/.exec(screen.slice(Math.max(0, screen.indexOf("Memory files"))));
      counts[where] = summary ? `${summary[1]} files, ${summary[2]} tokens` : "";
      if (shared.length > 1 || rules.length > 1) duplicates = true;
      if (!shared.length && !summary) unclear = true;
      ev.push(
        `${where} (${dir}): ~/.claude/CLAUDE.md listed ${shared.length}×, the rule ${rules.length}×${summary ? `; memory files: ${counts[where]}` : ""}\n${[...shared, ...rules].join("\n") || tail(screen, 25)}`,
      );
    } catch (e) {
      unclear = true;
      ev.push(`${where}: the UI check didn't complete: ${(e as Error).message}`);
    } finally {
      if (t) s.killUi(t);
    }
  }
  // A file loaded twice under $HOME shows as more memory files there than outside it.
  const base = counts["outside $HOME"];
  if (base && ["under $HOME", "$HOME itself"].some((w) => counts[w] && counts[w] !== base)) duplicates = true;
  s.record(2, "files loaded twice", duplicates ? "decide" : unclear ? "manual" : "pass", [
    ...ev,
    "Also: from $HOME itself ~/.claude/settings.json loads as project settings (F12 in docs/architecture.md); check the $HOME capture above.",
    ...(duplicates ? ["Duplicates under $HOME: decide with the owner (accept them, or stop linking rules)."] : []),
  ]);
}

async function spike13(s: Suite, fx: Fixture): Promise<void> {
  const ev: string[] = [];
  let verdict = "pass" as "pass" | "fail" | "decide" | "manual";
  const dir = s.accountDir("a");
  const aside = `${dir}.spike13`;
  /**
   * Runs fn with a's dir replaced: gone, or holding only its links into the store, as
   * `rm` leaves it. Puts the dir back afterwards, even if something recreated it meanwhile.
   */
  const withoutA = (fn: () => void, leftover = false) => {
    fs.renameSync(dir, aside);
    try {
      if (leftover) {
        fs.mkdirSync(dir, { mode: 0o700 });
        for (const e of fs.readdirSync(aside)) {
          const p = path.join(aside, e);
          if (fs.lstatSync(p).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(p), path.join(dir, e));
        }
      }
      fn();
    } finally {
      if (leftover) {
        const written = fs.existsSync(dir) ? fs.readdirSync(dir).filter((e) => !fs.lstatSync(path.join(dir, e)).isSymbolicLink()) : [];
        if (written.length) ev.push(`files written into a's leftover folder meanwhile: ${written.join(", ")}`);
        fs.rmSync(dir, { recursive: true, force: true });
      } else if (fs.existsSync(dir)) {
        const recreated = `${dir}.recreated-${Date.now()}`;
        fs.renameSync(dir, recreated);
        verdict = "decide";
        ev.push(`a's dir was recreated while it was gone (kept as ${recreated}): ${listTree(recreated).slice(0, 12).join(", ")}`);
      }
      fs.renameSync(aside, dir);
    }
  };
  // A fresh large output in a's conversation (its last line exists only in the saved file),
  // then b reads that file through the path a's session recorded, with a removed: its
  // folder holds only the links `rm` keeps (with no folder at all, that can't work).
  if (fx.convId) {
    const convId = fx.convId;
    const big = largeOutput(s, fx);
    ev.push(big.note);
    const dbg = path.join(s.root, "debug-13.log");
    const since = new Date().toISOString();
    withoutA(() => {
      const r = s.prompt("b", READ_SAVED, { cwd: s.work.w1, extra: ["-r", convId, "--allowedTools", "Read"], debugFile: dbg });
      const ok = s.opts.fake || (big.line !== null && r.text.includes(big.line));
      ev.push(
        `b resumed a's conversation with a removed (only its links left), saved output's last line: ${JSON.stringify(r.text.slice(0, 60))} (${ok ? "right" : big.line ? `WRONG, it's ${big.line}` : "couldn't check"})`,
      );
      const turns = turnsSince(s, convId, since);
      const errors = turns.reduce((n, t) => n + t.errors, 0);
      ev.push(`b's tool calls: ${turns.flatMap((t) => t.tools).join("; ") || "none"}${errors ? ` (${errors} failed)` : ""}`);
      const named = grepLines(read(dbg), /accounts\/a\//, 10);
      if (named.length) ev.push(`debug lines naming a's dir:\n${named.join("\n")}`);
      if (!ok && big.line) {
        verdict = "decide";
        ev.push("The large tool output couldn't be reopened through a removed account's links: STOP and decide what to do.");
      } else if (!ok && verdict === "pass") verdict = "manual";
    }, true);
  }
  // Plugin paths recorded by the installing account.
  if (!s.opts.fake) {
    const market = path.join(s.root, "market");
    fs.mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(market, "demo", ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(market, "demo", "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(market, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "spike-market", owner: { name: "spike" }, plugins: [{ name: "demo", source: "./demo", description: "spike 13" }] }),
    );
    fs.writeFileSync(path.join(market, "demo", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0", description: "spike 13" }));
    fs.writeFileSync(path.join(market, "demo", "commands", "hello.md"), "---\ndescription: say hello\n---\nSay hello.\n");
    const steps: Array<[string, string[]]> = [
      ["marketplace add", ["a", "plugin", "marketplace", "add", market]],
      ["install", ["a", "plugin", "install", "demo@spike-market"]],
      ["enable in b", ["b", "plugin", "enable", "demo@spike-market"]],
    ];
    const failed = steps.filter(([, args]) => s.xc(args).status !== 0).map(([name]) => name);
    const registry = read(path.join(s.store, "plugins", "installed_plugins.json"));
    if (failed.length || !registry.includes("demo@spike-market")) {
      ev.push(`the plugin setup didn't work (${failed.join(", ") || "not in the registry"}), so the plugin part proves nothing`);
      if (verdict === "pass") verdict = "manual";
    } else {
      ev.push(`installPath recorded under a's dir: ${registry.includes(`${s.xhome}/accounts/a/`)}`);
      const dbg = path.join(s.root, "debug-13-plugin.log");
      withoutA(() => {
        s.prompt("b", "Reply with just OK.", { cwd: s.work.w1, debugFile: dbg });
      });
      const lines = grepLines(read(dbg), /spike-market|plugin[^\n]*\bdemo\b/i, 12);
      const broken = lines.some((l) => /ENOENT|not found|fail|error|missing/i.test(l));
      const loaded = !broken && lines.some((l) => /load/i.test(l));
      ev.push(`with a's dir gone, b ${broken ? "could NOT load" : loaded ? "loaded" : "may not have loaded"} the plugin${lines.length ? `:\n${lines.join("\n")}` : " (no debug lines about it)"}`);
      if (broken && verdict === "pass") {
        verdict = "fail";
        ev.push("Plugin paths are used as written: switch normalizePaths on.");
      } else if (!loaded && verdict === "pass") verdict = "manual";
    }
  }
  // Other shared files holding account-dir paths.
  const hits = filesContaining(s.store, `${s.xhome}/accounts/`).map((f) => path.relative(s.store, f));
  const byTop = new Map<string, number>();
  for (const h of hits) byTop.set(h.split("/")[0]!, (byTop.get(h.split("/")[0]!) ?? 0) + 1);
  ev.push(`shared files naming an account dir: ${[...byTop].map(([k, v]) => `${k} (${v})`).join(", ") || "none"}`);
  s.record(13, "account-dir paths in shared files", verdict, ev);
}

async function spike5(s: Suite): Promise<void> {
  const skills = path.join(s.store, "skills");
  const local = path.join(skills, `local-${s.runId}`, "SKILL.md");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const content = `---\nname: local-${s.runId}\ndescription: spike 5\n---\nA local skill.\n`;
  fs.writeFileSync(local, content);
  const snap = () => ({ synced: listTree(path.join(skills, "synced")), trash: listTree(path.join(skills, ".trash")) });
  const ev: string[] = [];
  const snaps = [snap()];
  const failedRuns: string[] = [];
  for (const n of ["a", "b", "a", "b"]) {
    const r = s.prompt(n, "Reply with just OK.", { cwd: s.work.w1 });
    if (!r.text.includes("OK")) failedRuns.push(`${n}: ${JSON.stringify(r.text.slice(0, 60))}`);
    snaps.push(snap());
  }
  snaps.forEach((sn, i) => ev.push(`after run ${i}: synced ${sn.synced.length} entries, .trash ${sn.trash.length}`));
  const churn = JSON.stringify(snaps[1]) !== JSON.stringify(snaps[3]) || JSON.stringify(snaps[2]) !== JSON.stringify(snaps[4]);
  const intact = read(local) === content;
  const provisioned = snaps.some((sn) => sn.synced.length > 0);
  ev.push(`local skill ${intact ? "untouched" : "CHANGED or gone"}`);
  if (failedRuns.length) ev.push(`some runs failed, so they couldn't provision anything: ${failedRuns.join("; ")}`);
  const status = !intact || churn ? "fail" : failedRuns.length || !provisioned ? "manual" : "pass";
  if (!provisioned) ev.push("neither org provisioned skills during the run, so churn couldn't show");
  if (status === "fail") ev.push("fallback: switch shareSkills off");
  s.record(5, "shared skills/ with two orgs", status, ev);
}

async function spike14(s: Suite): Promise<void> {
  const ev: string[] = [];
  const a = authOf(s, "a");
  const a2 = authOf(s, "a2");
  ev.push(`a: ${a.email}, a2: ${a2.email}`);
  if (!a.loggedIn || !a2.loggedIn || a.email !== a2.email) return s.record(14, "logout and other logins", "manual", [...ev, "a and a2 must be the same user, both logged in"]);
  s.xc(["a2", "auth", "logout"]);
  const after = authOf(s, "a");
  const works = s.prompt("a", "Reply with just OK.", { cwd: s.work.w1 }).text.includes("OK");
  ev.push(`after logging a2 out: a still logged in: ${after.loggedIn}; a still answers: ${works}`);
  const other = s.ask(`On your second machine, logged in as ${a.email}: does Claude Code still answer a prompt?`);
  ev.push(`second machine still works (owner): ${other}`);
  const ok = after.loggedIn && works && other;
  ev.push(ok ? "logout doesn't affect other logins: keepSameEmailLogin can stay off" : "logout affects other logins: keep the same-email exception");
  s.record(14, "logout and other logins", ok ? "pass" : "fail", ev);
}

async function spike8(s: Suite, before: string[], part: "entries" | "logout"): Promise<void> {
  if (process.platform !== "darwin" || s.opts.fake) return;
  if (part === "entries") {
    const ev: string[] = [];
    const creds = ["a", "b"].filter((n) => fs.existsSync(path.join(s.accountDir(n), ".credentials.json")));
    const added = keychainEntries().filter((e) => !before.includes(e));
    ev.push(`new Claude Code Keychain entries since the run started: ${added.join(", ") || "none"}`);
    if (creds.length) {
      ev.push(`${creds.join(", ")} have a .credentials.json, so the Keychain wasn't used under the scratch home: this run proves nothing.`);
      ev.push("Rerun in the real home without xclaude: `CLAUDE_CONFIG_DIR=<scratch dir> claude` once per account, log in, then compare `security dump-keychain | grep 'Claude Code'`.");
      return s.record(8, "macOS Keychain per config dir", "manual", ev);
    }
    return s.record(8, "macOS Keychain per config dir (entries)", added.length >= 2 ? "pass" : "fail", ev);
  }
  if (!s.ask("Spike 8's last check logs account a out. Like spike 14, a logout could end other sessions of that user. Go ahead?")) {
    return s.record(8, "macOS Keychain per config dir (logout)", "skip", ["skipped by the owner"]);
  }
  s.xc(["a", "auth", "logout"]);
  const b = authOf(s, "b");
  s.record(8, "macOS Keychain per config dir (logout)", b.loggedIn ? "pass" : "fail", [`after logging a out, b is still logged in: ${b.loggedIn}`]);
}

/** On macOS, the hand checks with the scratch install. */
async function macHandChecks(s: Suite): Promise<void> {
  if (process.platform !== "darwin" || s.opts.fake) return;
  s.xc(["shell", "install", "--zsh"]);
  const shell = `env HOME=${s.home} TMUX_TMPDIR=${s.tmuxTmp} XCLAUDE_CLAUDE_PATH=${s.claude} PATH=${path.join(s.prefix, "bin")}:$PATH zsh -i`;
  s.say(`\nHand checks (a few minutes). In another terminal, start a scratch shell:\n  ${shell}\nThen try:`);
  s.say("  1. xclaude            → the picker (arrows, digits, Enter); then in Claude: Ctrl-Z, fg, resize the window, Ctrl-C twice");
  s.say("  2. xclaude a<TAB>     → completion; also xclaude a --mo<TAB> and xclaude a --model <TAB>");
  s.say("  3. xclaude tmux new hc --detach --empty; xclaude tmux new hc2 --detach --empty; xclaude tmux attach hc");
  s.say("     → attached; inside it, xclaude tmux attach hc2 switches to the other session");
  const answers = [
    ["the picker, and Ctrl-Z, fg, resize and Ctrl-C in Claude", s.ask("Did the picker and the terminal keys behave normally?")],
    ["zsh completion", s.ask("Did completion work?")],
    ["tmux attach from outside and switching from inside", s.ask("Did tmux attach and switch work?")],
  ] as const;
  s.record(9, "macOS hand checks (picker, terminal, completion, tmux)", answers.every(([, a]) => a) ? "pass" : "fail", answers.map(([what, a]) => `${what}: ${a ? "yes" : "NO"}`));
}

async function editorAndBrowser(s: Suite, which: number[]): Promise<void> {
  const real = os.homedir();
  const backup = path.join(real, `xclaude-spike-backup-${s.runId}.tgz`);
  const members = [".claude", ".claude.json"].filter((m) => fs.existsSync(path.join(real, m)));
  spawnSync("tar", ["-czf", backup, "-C", real, ...members], { stdio: "ignore" });
  s.say(`\nBacked up ${members.join(" and ")} to ${backup}. Restore with:\n  rm -rf ~/.claude ~/.claude.json && tar -xzf ${backup} -C ~\n`);
  const xhome = path.join(s.root, "xhome-real");
  const x = s.xclaude;
  s.say(`In another terminal, use these accounts (they log in again, in your real home):\n  export XCLAUDE_HOME=${xhome} XCLAUDE_CLAUDE_PATH=${s.claude}\n  ${x} add a   # and: ${x} add b\n`);
  if (which.includes(11)) {
    s.say(`Spike 11: open VS Code with the Claude Code extension (it runs as plain claude), then run \`${x} a\` in a terminal and type /ide.`);
    const found = s.ask("Did /ide find VS Code, listed once?");
    s.record(11, "/ide without linking ide/", found ? "pass" : "fail", [`/ide found VS Code: ${found}`, ...(found ? [] : ["fallback: switch linkIde on and check no editor is listed twice"])]);
    s.say("Spike 6, VS Code part: in VS Code, open the Claude Code conversation history.");
    const history = s.ask(`Does VS Code's history list the conversations you had through \`${x} a\`?`);
    s.record(6, "linking all of projects/ (VS Code history)", history ? "pass" : "fail", [`VS Code's history lists the account's conversations: ${history}`]);
  }
  if (which.includes(7)) {
    s.say(`Spike 7: in two terminals run \`${x} a --chrome\` and \`${x} b --chrome\`, and ask each to open a web page.`);
    const both = s.ask("Could both sessions drive the browser?");
    s.record(7, "--chrome in two accounts", both ? "pass" : "fail", [`both sessions drove Chrome with chrome/ shared: ${both}`, ...(both ? [] : ["fallback: switch shareChrome off, and document the limitation"])]);
    s.say("Afterwards run `claude --chrome` once from plain claude to restore the browser's native-messaging manifest.");
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const s = new Suite(opts);
  const want = (n: number, optional = false) => (opts.only ? opts.only.includes(n) : !optional || opts.with.includes(n));
  const realProjects = path.join(os.homedir(), ".claude", "projects");
  const before = fs.existsSync(realProjects) ? fs.readdirSync(realProjects) : [];
  const osName = process.platform === "darwin" ? "macos" : "linux";
  s.reportFile = path.join(opts.fake ? s.root : path.join(repo, "spikes", "results"), `${localDate()}-${osName}-${opts.fake ? "rehearsal" : s.runId}.md`);
  // The owner's Keychain entries before the logins (macOS): spike 8 compares against them,
  // and the ones the run adds are removed at the end, after asking.
  let keychainBefore: string[] | null = null;
  let finished = false;
  const finish = (interrupted: boolean) => {
    if (finished) return;
    finished = true;
    const after = fs.existsSync(realProjects) ? fs.readdirSync(realProjects) : [];
    const leaked = after.filter((d) => !before.includes(d) && d.includes(s.runId));
    s.notes.push(leaked.length ? `WARNING: the real ~/.claude/projects gained ${leaked.join(", ")}` : "the real ~/.claude/projects gained nothing (HOME is honored)");
    const added = keychainBefore ? keychainEntries().filter((e) => !keychainBefore!.includes(e)) : [];
    if (added.length) {
      s.say(`\nThe test logins created these Keychain entries: ${added.join(", ")}`);
      const left = !interrupted && s.ask("Remove them now?") ? added.filter((e) => spawnSync("security", ["delete-generic-password", "-s", e], { stdio: "ignore" }).status !== 0) : added;
      if (left.length) {
        const commands = left.map((e) => `security delete-generic-password -s '${e}'`);
        s.notes.push(`Keychain entries from the test logins are left; remove them with: ${commands.join("; ")}`);
        s.say(`Remove the rest with:\n  ${commands.join("\n  ")}`);
      } else {
        s.notes.push(`the test logins' Keychain entries were removed (${added.length})`);
      }
    }
    s.saveReport();
    s.say(`\nResults: ${s.reportFile}`);
    s.cleanup();
  };
  // Ctrl-C keeps what's done and stops the scratch tmux server. One meant for a login screen is ignored.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (sig === "SIGINT" && Date.now() - s.lastInteractiveEnd < 1500) return;
      s.say("\nInterrupted.");
      finish(true);
      process.exit(130);
    });
  }
  try {
    s.say(`xclaude spike suite (${opts.fake ? "rehearsal with the fake claude" : "real Claude Code"}), scratch root ${s.root}`);
    s.setup();
    s.say(`Claude Code ${s.claudeVersion}`);
    if (process.platform === "darwin" && !opts.fake) keychainBefore = keychainEntries();
    // Spikes 7 and 11 use the real home with their own logins; the rest need two scratch logins.
    const scratch = !opts.only || opts.only.some((n) => n !== 7 && n !== 11);
    if (scratch) {
      if (!opts.fake) {
        s.say(
          "\nThis run needs logins: account a and account b" +
            (want(5, true) ? " (two different orgs that both provision skills)" : "") +
            (want(14, true) ? ", plus a2: the SAME user as a" : "") +
            ".",
        );
        s.say(
          "Everything runs in a scratch home; your real ~/.claude, ~/.xclaude and logins aren't touched." +
            (process.platform === "darwin" ? " The test logins go into your login keychain until the end, when the run offers to remove them." : ""),
        );
      }
      if (!(await login(s, "a", "account A"))) throw new Error("account a isn't logged in");
      if (!(await login(s, "b", want(5, true) ? "account B (a different org from A)" : "account B"))) throw new Error("account b isn't logged in");
      if (want(14, true) && !(await login(s, "a2", "the SAME claude.ai user as account a"))) throw new Error("account a2 isn't logged in");
      const doctor = s.xc(["doctor"]);
      s.notes.push(`xclaude doctor after the logins: exit ${doctor.status}`);

      const fx: Fixture = { word: `pelican${s.runId}`, convId: null };
      const steps: Array<[number, () => Promise<void>, boolean]> = [
        [8, () => spike8(s, keychainBefore ?? [], "entries"), false],
        [12, () => spike12(s, fx), false],
        [6, () => spike6(s, fx), false],
        [1, () => spike1(s, fx), false],
        [3, () => spike3(s), false],
        [4, () => spike4(s), false],
        [2, () => spike2(s), false],
        [13, () => spike13(s, fx), false],
        [5, () => spike5(s), true],
        [14, () => spike14(s), true],
      ];
      for (const [id, step, optional] of steps) {
        if (!want(id, optional)) continue;
        if (fx.convId === null && [6, 1, 13].includes(id)) {
          fx.convId = s.prompt("a", `Remember the word ${fx.word}. Reply with just OK.`, { cwd: s.work.w1 }).sessionId;
        }
        try {
          await step();
        } catch (e) {
          s.record(id, "(the check crashed)", "manual", [`the check itself failed: ${(e as Error).stack ?? e}`]);
        }
      }
      if (want(9)) await macHandChecks(s);
      if (want(8)) await spike8(s, keychainBefore ?? [], "logout");
    }
    const extra = opts.with.filter((n) => n === 7 || n === 11);
    if (extra.length && !opts.fake) await editorAndBrowser(s, extra);
  } finally {
    finish(false);
  }
  const bad = s.results.filter((r) => r.status === "fail" || r.status === "decide");
  s.say(bad.length ? `${bad.length} spike result(s) need attention: ${bad.map((r) => r.id).join(", ")}` : "No failures.");
  if (opts.fake && !opts.keep) s.say("(rehearsal: the scratch root and its results are removed; pass --keep to look at them)");
  return bad.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`spike suite failed: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  },
);
