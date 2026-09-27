#!/usr/bin/env node
// Fake `claude` for tests. It records every call (argv, environment, cwd) as one
// JSON line in $FAKE_CLAUDE_LOG and answers a few subcommands from fixtures.
//
// Login state lives in <config dir>/.credentials.json ({ email, orgId, orgName }).
// Knobs, all optional:
//   FAKE_CLAUDE_LOGIN   JSON login written on an interactive launch (like /login)
//   FAKE_CLAUDE_AGENTS  path of a JSON file printed by `agents --json`
//   FAKE_CLAUDE_EXIT    exit code of an interactive launch (default 0)
//   FAKE_CLAUDE_WAIT    "1": wait for a signal instead of exiting
//   FAKE_CLAUDE_HELP    path of the text printed by `--help`
//   FAKE_CLAUDE_AUTH_FAIL  comma-separated config dir names whose `auth status` fails
//
// With FAKE_CLAUDE_CONVERSE=1 and -p it keeps a tiny conversation per session under <config dir>/projects,
// like Claude Code: -c continues the newest one in the directory, -r <id> any
// one. "Remember the word X" is answered with OK, "which word" with X. The spike
// suite's rehearsal uses this to check that conversations cross accounts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const env = process.env;
const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || "/nonexistent", ".claude");
const authFile = path.join(configDir, ".credentials.json");

function record(extra = {}) {
  if (!env.FAKE_CLAUDE_LOG) return;
  const entry = { argv: args, env: { ...env }, cwd: process.cwd(), pid: process.pid, ...extra };
  fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
}

function readLogin() {
  try {
    return JSON.parse(fs.readFileSync(authFile, "utf8"));
  } catch {
    return null;
  }
}

function authStatus() {
  const login = readLogin();
  const status = {
    loggedIn: Boolean(login),
    authMethod: login ? "claude.ai" : "none",
    apiProvider: "firstParty",
    analyticsDisabled: false,
    projectsDirectory: path.join(configDir, "projects"),
    configDirectory: configDir,
  };
  if (login) {
    status.email = login.email ?? null;
    status.orgId = login.orgId ?? null;
    status.orgName = login.orgName ?? null;
    status.subscriptionType = login.subscriptionType ?? "max";
  }
  if (args.includes("--text")) {
    process.stdout.write(login ? `Logged in as ${login.email}\n` : "Not logged in\n");
  } else {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  }
  process.exit(login ? 0 : 1);
}

function waitForSignal() {
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    process.on(sig, () => {
      record({ event: "signal", signal: sig });
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
  record({ event: "ready" });
  setInterval(() => {}, 1 << 30);
}

const [first, second] = args;

if (first === "--version" || first === "-v") {
  record();
  process.stdout.write("2.1.282 (Claude Code)\n");
} else if (first === "--help" || first === "-h") {
  record();
  const helpFile = env.FAKE_CLAUDE_HELP || path.join(here, "..", "fixtures", "claude-help.txt");
  process.stdout.write(fs.readFileSync(helpFile, "utf8"));
} else if (first === "auth" && second === "status") {
  record();
  if ((env.FAKE_CLAUDE_AUTH_FAIL ?? "").split(",").includes(path.basename(configDir))) {
    process.stderr.write("auth status: something went wrong\n");
    process.exit(2);
  }
  authStatus();
} else if (first === "auth" && second === "logout") {
  record();
  fs.rmSync(authFile, { force: true });
  process.stdout.write("Successfully logged out from your Anthropic account.\n");
} else if (first === "auth" && second === "login") {
  record();
  if (env.FAKE_CLAUDE_LOGIN) fs.writeFileSync(authFile, env.FAKE_CLAUDE_LOGIN);
} else if (first === "agents" && args.includes("--json")) {
  record();
  const file = env.FAKE_CLAUDE_AGENTS;
  process.stdout.write(file ? fs.readFileSync(file, "utf8") : `${JSON.stringify(liveSessions())}\n`);
} else if (first === "daemon") {
  record();
} else if (env.FAKE_CLAUDE_CONVERSE === "1" && (args.includes("-p") || args.includes("--print"))) {
  record();
  printMode();
} else {
  if (env.FAKE_CLAUDE_LOGIN && !readLogin()) {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(authFile, env.FAKE_CLAUDE_LOGIN);
  }
  if (env.FAKE_CLAUDE_WAIT === "1") {
    waitForSignal();
  } else if (env.FAKE_CLAUDE_CONVERSE === "1" && process.stdin.isTTY) {
    record();
    repl();
  } else {
    record();
    process.exit(Number(env.FAKE_CLAUDE_EXIT || 0));
  }
}

function printMode() {
  if (!readLogin()) {
    process.stdout.write("Not logged in · Please run /login\n");
    process.exit(1);
  }
  const flag = (name) => {
    const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i < 0) return undefined;
    return args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[i + 1];
  };
  const valueFlags = new Set(["--model", "--effort", "--output-format", "--debug-file", "-r", "--resume", "--allowedTools", "--allowed-tools", "--add-dir", "--settings"]);
  let prompt = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.has(a)) i++;
    else if (!a.startsWith("-")) prompt = a;
  }
  const projects = path.join(configDir, "projects");
  const dir = path.join(projects, process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  let id = flag("-r") ?? flag("--resume");
  let file = null;
  if (id) {
    for (const d of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
      if (fs.existsSync(path.join(projects, d, `${id}.jsonl`))) file = path.join(projects, d, `${id}.jsonl`);
    }
    if (!file) {
      process.stdout.write(`No conversation found with session ID: ${id}\n`);
      process.exit(1);
    }
  } else if (args.includes("-c") || args.includes("--continue")) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")) : [];
    const newest = files.map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (!newest) {
      process.stdout.write("No conversation found to continue\n");
      process.exit(1);
    }
    file = path.join(dir, newest.n);
    id = newest.n.slice(0, -".jsonl".length);
  } else {
    id = crypto.randomUUID();
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${id}.jsonl`);
  }
  const history = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const said = history.map((e) => e.message?.content ?? "").join("\n");
  const remembered = [...said.matchAll(/[Rr]emember the word (\S+?)[.,!]?(?:\s|$)/g)].at(-1)?.[1];
  const result = /which word|what word/i.test(prompt) ? (remembered ?? "I don't know") : "OK";
  fs.appendFileSync(file, `${JSON.stringify({ type: "user", sessionId: id, entrypoint: "sdk-cli", message: { role: "user", content: prompt } })}\n`);
  fs.appendFileSync(file, `${JSON.stringify({ type: "assistant", sessionId: id, entrypoint: "sdk-cli", message: { role: "assistant", content: result } })}\n`);
  const debugFile = flag("--debug-file");
  if (debugFile) fs.writeFileSync(debugFile, `[DEBUG] fake claude, session ${id}\n`);
  if (flag("--output-format") === "json") process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: id })}\n`);
  else process.stdout.write(`${result}\n`);
  process.exit(0);
}

/** Live interactive sessions registered in <config dir>/sessions, like Claude Code's registry. */
function liveSessions() {
  const dir = path.join(configDir, "sessions");
  const out = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      process.kill(entry.pid, 0);
      out.push({ cwd: entry.cwd, kind: "interactive", startedAt: entry.startedAt, pid: entry.pid, status: "idle" });
    } catch {
      // gone
    }
  }
  return out;
}

/** A minimal interactive session for the spike-suite rehearsal. */
async function repl() {
  const readline = await import("node:readline");
  const sessions = path.join(configDir, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const mine = path.join(sessions, `${process.pid}.json`);
  fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, cwd: process.cwd(), startedAt: Date.now() }));
  const projects = path.join(configDir, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  const say = (text) => process.stdout.write(`${text}\n> `);
  // Typed prompts make an interactive transcript, which /resume lists; like Claude Code, it
  // leaves out print-mode (-p) conversations.
  const transcript = path.join(projects, `${crypto.randomUUID()}.jsonl`);
  const firstEntry = (n) => JSON.parse(fs.readFileSync(path.join(projects, n), "utf8").split("\n")[0]);
  process.stdout.write("fake claude\n  ? for shortcuts\n> ");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.replace(/\x1b\[?[0-9;]*[A-Za-z~]?/g, "").trim();
    if (!text) return;
    // Prompts and slash commands both go into history.jsonl, under a lock on its resolved path, like Claude Code.
    const history = path.join(configDir, "history.jsonl");
    const real = fs.existsSync(history) ? fs.realpathSync(history) : history;
    const lock = `${real}.lock`;
    for (let i = 0; i < 200; i++) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    fs.appendFileSync(history, `${JSON.stringify({ display: text, pastedContents: {}, timestamp: Date.now(), project: process.cwd() })}\n`);
    fs.rmdirSync(lock);
    if (text === "/resume" || text === "/rewind") {
      const files = fs.existsSync(projects) ? fs.readdirSync(projects).filter((n) => n.endsWith(".jsonl")) : [];
      const listed = text === "/rewind" ? files : files.filter((n) => firstEntry(n).entrypoint !== "sdk-cli");
      const firsts = listed.map((n) => firstEntry(n).message.content);
      say(`${text === "/resume" ? "Resume a conversation" : "Rewind to"}:\n${firsts.map((f) => `  ${f}`).join("\n")}`);
    } else if (text === "/stats") {
      say("Usage: 1 day, some sessions");
    } else if (text.startsWith("/context")) {
      const rules = path.join(env.HOME, ".claude", "rules");
      const ruleFiles = fs.existsSync(rules) ? fs.readdirSync(rules).map((r) => `  ~/.claude/rules/${r}`) : [];
      say(`Memory files\n  ${path.join(configDir, "CLAUDE.md")}\n  ~/.claude/CLAUDE.md\n${ruleFiles.join("\n")}\n  ? for shortcuts`);
    } else {
      fs.mkdirSync(projects, { recursive: true });
      fs.appendFileSync(transcript, `${JSON.stringify({ type: "user", entrypoint: "cli", message: { role: "user", content: text } })}\n`);
      say("OK\n  ? for shortcuts");
    }
  });
  const bye = () => {
    fs.rmSync(mine, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", bye);
  process.on("SIGHUP", bye);
  rl.on("close", bye);
}
