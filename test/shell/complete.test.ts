// `xclaude __complete`: every context, then the real bash and zsh
// functions around it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { complete, formatCompletion, logicalWords, suggestLabel } from "../../src/shell/complete.ts";
import { initBash } from "../../src/shell/init.ts";
import { testCtx, type TestCtx } from "../helpers/ctx.ts";
import { findTool, makeSandbox, missingTool, type Sandbox } from "../helpers/sandbox.ts";
import { capture, needTmux, tmux, waitFor } from "../helpers/tmux.ts";
import { median, reportTiming } from "../helpers/timing.ts";

describe("logicalWords", () => {
  it("joins bash's --flag = value split back together", () => {
    assert.deepEqual(logicalWords("bash", ["xclaude", "acme", "--model", "=", "op"], 4), { prior: ["xclaude", "acme"], cur: "--model=op" });
    assert.deepEqual(logicalWords("bash", ["xclaude", "acme", "--model", "="], 3), { prior: ["xclaude", "acme"], cur: "--model=" });
    assert.deepEqual(logicalWords("bash", ["xclaude", "acme", "--model", "=", "opus", "-"], 5), { prior: ["xclaude", "acme", "--model=opus"], cur: "-" });
    assert.deepEqual(logicalWords("zsh", ["xclaude", "acme", "--model=op"], 2), { prior: ["xclaude", "acme"], cur: "--model=op" });
    assert.deepEqual(logicalWords("bash", ["xclaude", ""], 1), { prior: ["xclaude"], cur: "" });
  });

  it("suggests a label from the directory name", () => {
    assert.equal(suggestLabel("/home/u/code/my.api"), "my-api");
    assert.equal(suggestLabel("/home/u/.hidden"), "hidden");
    assert.equal(suggestLabel("/"), null);
  });
});

describe("completion contexts", () => {
  let ctx: TestCtx;
  beforeEach(() => {
    ctx = testCtx();
    ctx.setConfig((c) => {
      c.accounts.acme = { model: "opus", effort: "max", args: [] };
      c.accounts.beta = { model: null, effort: null, args: [] };
      c.main.enabled = true;
    });
  });
  afterEach(() => ctx.cleanup());

  const values = (words: string[], shell: "bash" | "zsh" = "zsh") => {
    const r = complete(ctx, ctx.paths && require_config(), shell, words.length - 1, ["xclaude", ...words.slice(1)]);
    return { directive: r.completion.directive, values: r.completion.items.map((i) => i.value), items: r.completion.items, cur: r.cur };
  };
  // The config as the hidden command would load it.
  const require_config = () => JSON.parse(fs.readFileSync(ctx.paths.config, "utf8"));

  it("offers commands and accounts first, with descriptions", () => {
    const r = values(["xclaude", ""]);
    assert.deepEqual(r.values, ["add", "rm", "ls", "set", "tmux", "doctor", "shell", "guard", "help", "acme", "beta", "main"]);
    assert.equal(r.items.find((i) => i.value === "acme")!.description, "account · opus · max");
    assert.equal(r.items.find((i) => i.value === "add")!.description, "add an account and log in");
    assert.deepEqual(values(["xclaude", "a"]).values, ["add", "acme"]);
  });

  it("offers Claude's flags after - (the picker path) and after an account", () => {
    assert.ok(values(["xclaude", "--ch"]).values.includes("--chrome"));
    const r = values(["xclaude", "acme", "--add"]);
    assert.deepEqual(r.values, ["--add-dir"]);
    assert.match(r.items[0]!.description!, /^Additional directories/);
    assert.ok(values(["xclaude", "-c", "--ver"]).values.includes("--verbose"));
  });

  it("offers Claude's subcommands right after the account", () => {
    const r = values(["xclaude", "acme", ""]).values;
    for (const s of ["agents", "auth", "daemon", "mcp", "plugin", "update"]) assert.ok(r.includes(s), s);
    assert.deepEqual(values(["xclaude", "acme", "auth", ""]).directive, "files", "after a subcommand, plain file completion");
  });

  it("completes flag values: models, efforts, choices", () => {
    assert.deepEqual(values(["xclaude", "acme", "--model", ""]).values, ["default", "best", "fable", "opus", "sonnet", "haiku", "opus[1m]", "sonnet[1m]", "opusplan"]);
    assert.deepEqual(values(["xclaude", "acme", "--effort", "x"]).values, ["xhigh"]);
    assert.deepEqual(values(["xclaude", "acme", "--effort", ""]).values, ["low", "medium", "high", "xhigh", "max", "ultracode"]);
    assert.deepEqual(values(["xclaude", "acme", "--permission-mode", "a"]).values, ["acceptEdits", "auto"]);
  });

  it("handles --flag=value in zsh and bash", () => {
    assert.deepEqual(values(["xclaude", "acme", "--model=op"]).values, ["--model=opus", "--model=opus[1m]", "--model=opusplan"]);
    const r = complete(ctx, require_config(), "bash", 4, ["xclaude", "acme", "--model", "=", "op"]);
    assert.equal(formatCompletion(r.completion, "bash", r.cur), "default\nopus\nopus[1m]\nopusplan\n", "bash gets the part after =");
  });

  it("returns path directives for path-valued flags, also inside a variadic list", () => {
    assert.equal(values(["xclaude", "acme", "--add-dir", ""]).directive, "dirs");
    assert.equal(values(["xclaude", "acme", "--add-dir", "/a", ""]).directive, "dirs");
    assert.equal(values(["xclaude", "acme", "--add-dir=/"]).directive, "dirs");
    assert.equal(values(["xclaude", "acme", "--plugin-dir", ""]).directive, "dirs");
    assert.equal(values(["xclaude", "acme", "--settings", ""]).directive, "files");
    assert.equal(values(["xclaude", "acme", "--debug-file", ""]).directive, "files");
    assert.deepEqual(values(["xclaude", "acme", "-c", ""]).values, [], "a prompt gets nothing");
  });

  it("lists recent sessions of the directory for --resume", () => {
    const dir = path.join(ctx.paths.store, "projects", ctx.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "11111111-aaaa.jsonl"), `${JSON.stringify({ type: "user", message: { role: "user", content: "fix the login bug please" } })}\n`);
    fs.writeFileSync(path.join(dir, "22222222-bbbb.jsonl"), `${JSON.stringify({ type: "summary", summary: "Refactor auth" })}\n`);
    fs.writeFileSync(path.join(dir, "notes.txt"), "");
    const r = values(["xclaude", "acme", "--resume", ""]);
    assert.deepEqual(r.values.sort(), ["11111111-aaaa", "22222222-bbbb"]);
    assert.equal(r.items.find((i) => i.value === "11111111-aaaa")!.description, "fix the login bug please");
    assert.equal(r.items.find((i) => i.value === "22222222-bbbb")!.description, "Refactor auth");
    assert.deepEqual(values(["xclaude", "acme", "-r", "2"]).values, ["22222222-bbbb"]);
  });

  it("completes xclaude's own commands", () => {
    assert.deepEqual(values(["xclaude", "set", ""]).values, ["acme", "beta", "main"]);
    assert.deepEqual(values(["xclaude", "set", "acme", "--"]).values, ["--model", "--effort", "--args", "--unset", "--enable", "--disable"]);
    assert.deepEqual(values(["xclaude", "set", "acme", "--unset", ""]).values, ["model", "effort", "args"]);
    assert.deepEqual(values(["xclaude", "set", "acme", "--effort=m"]).values, ["--effort=medium", "--effort=max"]);
    assert.deepEqual(values(["xclaude", "set", "acme", ""]).values, [], "one account only");
    assert.deepEqual(values(["xclaude", "rm", ""]).values, ["acme", "beta"]);
    assert.deepEqual(values(["xclaude", "rm", "acme", "-"]).values, ["--keep-login", "--leftovers", "-y"]);
    assert.deepEqual(values(["xclaude", "rm", "--leftovers", "-"]).values, ["-y"]);
    // A removed account's leftover folder can be deleted with rm too.
    fs.mkdirSync(path.join(ctx.paths.accounts, "old"), { recursive: true });
    fs.writeFileSync(path.join(ctx.paths.accounts, "acme.lock"), "");
    const rm = values(["xclaude", "rm", ""]);
    assert.deepEqual(rm.values, ["acme", "beta", "old"]);
    assert.equal(rm.items.find((i) => i.value === "old")!.description, "leftover folder of a removed account");
    assert.deepEqual(values(["xclaude", "add", "new", "--model", "s"]).values, ["sonnet", "sonnet[1m]"]);
    assert.deepEqual(values(["xclaude", "add", ""]).values, []);
    assert.deepEqual(values(["xclaude", "shell", ""]).values, ["install", "uninstall", "completion"]);
    assert.deepEqual(values(["xclaude", "shell", "install", ""]).values, ["--bash", "--zsh"]);
    assert.deepEqual(values(["xclaude", "shell", "completion", ""]).values, ["bash", "zsh"]);
    assert.deepEqual(values(["xclaude", "guard", ""]).values, ["on", "off", "status"]);
    assert.deepEqual(values(["xclaude", "doctor", ""]).values, ["--fix"]);
    assert.deepEqual(values(["xclaude", "help", "t"]).values, ["tmux"]);
    assert.deepEqual(values(["xclaude", "ls", ""]).values, []);
    assert.deepEqual(values(["xclaude", "nope", ""]).values, []);
  });

  it("completes tmux new: label, options, account, then Claude's arguments", () => {
    assert.deepEqual(values(["xclaude", "tmux", ""]).values, ["new", "attach", "ls", "kill"]);
    assert.deepEqual(values(["xclaude", "tmux", "new", ""]).values, [path.basename(ctx.cwd)]);
    assert.deepEqual(values(["xclaude", "tmux", "new", "api", "--"]).values, ["--dir", "--detach", "--empty"]);
    assert.equal(values(["xclaude", "tmux", "new", "api", "--dir", ""]).directive, "dirs");
    assert.deepEqual(values(["xclaude", "tmux", "new", "api", "--detach", ""]).values, ["acme", "beta", "main"]);
    assert.deepEqual(values(["xclaude", "tmux", "new", "api", "--dir", "/x", "acme", "--model", "h"]).values, ["haiku"]);
  });
});

describe("completion through the real shells", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
    fs.mkdirSync(sb.xhome, { recursive: true });
    fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify({ accounts: { acme: { model: "opus" }, beta: {} } }));
    fs.mkdirSync(path.join(sb.home, "projects", "alpha"), { recursive: true });
    fs.writeFileSync(path.join(sb.home, "projects", "notes.md"), "");
  });
  afterEach(() => sb.cleanup());

  /** COMP_WORDS the way bash builds them with the default COMP_WORDBREAKS: `=` and `:` are words of their own. */
  function bashWords(line: string): { words: string[]; cword: number } {
    const words = line.split(/\s+/).flatMap((w) => w.split(/([=:])/).filter((p) => p !== ""));
    if (/\s$/.test(line) || line === "") words.push("");
    return { words, cword: words.length - 1 };
  }

  function bashComplete(line: string): string[] {
    const init = path.join(sb.root, "init.bash");
    fs.writeFileSync(init, initBash("test", false));
    const { words, cword } = bashWords(line);
    const script = `. "$INIT"; COMP_WORDS=("$@"); COMP_CWORD=${cword}; COMP_LINE="$LINE"; COMP_POINT=\${#LINE}; _xclaude_complete; [ \${#COMPREPLY[@]} -gt 0 ] && printf '%s|\\n' "\${COMPREPLY[@]}"; true`;
    const res = sb.spawn("/bin/bash", ["-c", script, "bash", ...words], { env: { INIT: init, LINE: line }, cwd: path.join(sb.home, "projects") });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.split("\n").filter(Boolean).map((l) => l.slice(0, -1));
  }

  it("fills COMPREPLY in bash, with trailing spaces added by the function", () => {
    assert.deepEqual(bashComplete("xclaude a"), ["add ", "acme "]);
    assert.deepEqual(bashComplete("xclaude acme --effort x"), ["xhigh "]);
    assert.deepEqual(bashComplete("xclaude acme --model=op"), ["opus ", "opus[1m] ", "opusplan "]);
    assert.deepEqual(bashComplete("xclaude acme --model="), ["default ", "best ", "fable ", "opus ", "sonnet ", "haiku ", "opus[1m] ", "sonnet[1m] ", "opusplan "]);
    assert.deepEqual(bashComplete("xclaude acme --add-dir al"), ["alpha/"]);
    assert.deepEqual(bashComplete("xclaude acme --add-dir="), ["alpha/"]);
    assert.deepEqual(bashComplete("xclaude acme --settings no"), ["notes.md "]);
    assert.deepEqual(bashComplete("xclaude acme -c "), []);
  });

  it("reports completion latency", (t) => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      samples.push(sb.run(["__complete", "bash", "2", "xclaude", "acme", "--"]).ms);
    }
    reportTiming(t, "__complete (median of 5)", median(samples), 150);
  });

  it("works in bash 3.2 (the macOS /bin/bash), in Docker", (t) => {
    const docker = findTool("docker");
    const probe = docker ? spawnSync(docker, ["image", "inspect", "bash:3.2"], { stdio: "ignore" }) : null;
    if (!docker || probe?.status !== 0) {
      const pulled = docker ? spawnSync(docker, ["pull", "bash:3.2"], { stdio: "ignore", timeout: 120_000 }) : null;
      if (!docker || pulled?.status !== 0) {
        t.skip(missingTool("docker with the bash:3.2 image"));
        return;
      }
    }
    // The container has no Node, so xclaude is a stub replaying __complete's output.
    const dir = path.join(sb.root, "b32");
    fs.mkdirSync(path.join(dir, "work", "sub dir"), { recursive: true });
    fs.writeFileSync(path.join(dir, "work", "file one.txt"), "");
    fs.writeFileSync(path.join(dir, "init.bash"), initBash("test", false));
    fs.writeFileSync(
      path.join(dir, "run.sh"),
      `xclaude() { printf '%s' "$STUB"; }
. /t/init.bash
cd /t/work
try() { STUB=$1; COMP_WORDS=(xclaude "$2"); COMP_CWORD=1; _xclaude_complete; printf '[%s]' "\${COMPREPLY[@]}"; echo; }
try "$(printf 'default\\nadd\\nacme')" a
try "$(printf 'nospace\\n--dir=')" --d
try "files" fi
try "dirs" s
try "default" x
try "dirs" --add-dir=su
echo "BASH=$BASH_VERSION"
`,
    );
    const res = spawnSync(docker, ["run", "--rm", "-v", `${dir}:/t`, "bash:3.2", "bash", "/t/run.sh"], { encoding: "utf8", timeout: 120_000 });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.stdout.trim().split("\n"), ["[add ][acme ]", "[--dir=]", "[file\\ one.txt ]", "[sub\\ dir/]", "[]", "[sub\\ dir/]", "BASH=3.2.57(1)-release"]);
  });

  it("completes in an interactive zsh (Tab in a real terminal)", async (t) => {
    if (!needTmux(sb, t)) return;
    if (!fs.existsSync(path.join(sb.bin, "zsh"))) {
      t.skip(missingTool("zsh"));
      return;
    }
    const zdot = path.join(sb.root, "zdot");
    fs.mkdirSync(zdot);
    sb.run(["shell", "install", "--zsh"], { env: { ZDOTDIR: zdot } });
    // A zsh outside the standard prefix needs its modules; a normal install ignores this.
    const modules = process.env.XCLAUDE_TEST_ZSH_MODULES ?? "";
    fs.writeFileSync(
      path.join(zdot, ".zshrc"),
      `${modules ? `module_path=(${modules} $module_path)\n` : ""}PROMPT='%% '\nautoload -Uz compinit && compinit -u -D\n${fs.readFileSync(path.join(zdot, ".zshrc"), "utf8")}`,
    );
    const env = { ZDOTDIR: zdot };
    // -d skips the global rc files: Ubuntu's runs its own compinit, which can stop at a question.
    tmux(sb, ["new-session", "-d", "-s", "z", "-x", "120", "-y", "30", "-e", `ZDOTDIR=${zdot}`, path.join(sb.bin, "zsh"), "-d"], env);
    await waitFor(() => capture(sb, "z").includes("%"), "the zsh prompt", 10_000, () => capture(sb, "z"));
    tmux(sb, ["send-keys", "-t", "z", "xclaude ac", "Tab"]);
    await waitFor(() => /xclaude acme\s*$/m.test(capture(sb, "z")), "zsh to complete the account");
    tmux(sb, ["send-keys", "-t", "z", "C-u", "xclaude a", "Tab"]);
    await waitFor(() => capture(sb, "z").includes("add an account and log in"), "the list with descriptions");
    const screen = capture(sb, "z");
    assert.match(screen, /acme\s+-- account · opus/);
  });
});
