// add, set, ls and rm, end to end with the fake claude.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeLogin, makeSandbox, type Sandbox } from "../helpers/sandbox.ts";
import { capture, needTmux, startPane, tmux, waitFor } from "../helpers/tmux.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const config = () => JSON.parse(fs.readFileSync(path.join(sb.xhome, "config.json"), "utf8"));
const accDir = (name: string) => path.join(sb.xhome, "accounts", name);
const login = (email: string, orgId = "org-1", orgName = "Org One") => JSON.stringify({ email, orgId, orgName });

describe("add", () => {
  it("creates the account with its options, links it, runs claude, then checks the login", () => {
    const res = sb.run(["add", "acme", "--model", "opus", "--effort=max", "--args", "--add-dir ~/work '--append-system-prompt' 'be brief'"], {
      env: { FAKE_CLAUDE_LOGIN: login("a@acme.com") },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(config().accounts.acme, { model: "opus", effort: "max", args: ["--add-dir", path.join(sb.home, "work"), "--append-system-prompt", "be brief"] });
    assert.equal(fs.statSync(accDir("acme")).mode & 0o777, 0o700);
    assert.equal(fs.readlinkSync(path.join(accDir("acme"), "projects")), path.join(sb.store, "projects"));
    const calls = sb.fakeCalls();
    assert.deepEqual(calls[0]!.argv, [], "claude starts with no arguments for onboarding and /login");
    assert.equal(calls[0]!.env.CLAUDE_CONFIG_DIR, accDir("acme"));
    assert.deepEqual(calls[1]!.argv, ["auth", "status"]);
    assert.match(res.stderr, /acme is logged in as a@acme\.com \(Org One\)\. Launch it with: xclaude acme/);
  });

  it("explains how to log in later", () => {
    const res = sb.run(["add", "acme"]);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /acme isn't logged in yet\. Log in later with `xclaude acme auth login`, or \/login inside `xclaude acme`/);
    assert.ok(config().accounts.acme);
  });

  it("warns when the login duplicates another identity's", () => {
    sb.run(["add", "acme"], { env: { FAKE_CLAUDE_LOGIN: login("a@acme.com") } });
    const res = sb.run(["add", "again"], { env: { FAKE_CLAUDE_LOGIN: login("a@acme.com") } });
    assert.match(res.stderr, /warning: again and acme use the same login \(a@acme\.com \(Org One\)\)/);
    const other = sb.run(["add", "third"], { env: { FAKE_CLAUDE_LOGIN: login("a@acme.com", "org-2", "Org Two") } });
    assert.doesNotMatch(other.stderr, /warning/, "same email in another org is fine");
  });

  it("validates before creating anything", () => {
    for (const [args, re] of [
      [["add"], /usage: xclaude add <name>/],
      [["add", "main"], /reserved for the main identity/],
      [["add", "tmux"], /reserved: it's an xclaude command/],
      [["add", "Bad"], /isn't a valid account name/],
      [["add", "acme", "--effort", "extreme"], /--effort must be one of/],
      [["add", "acme", "--args", "'open"], /unterminated '/],
      [["add", "acme", "--bogus"], /add: unknown option --bogus/],
    ] as const) {
      const res = sb.run([...args]);
      assert.equal(res.status, 2, args.join(" "));
      assert.match(res.stderr, re);
    }
    assert.equal(fs.existsSync(path.join(sb.xhome, "accounts")), false);
    sb.run(["add", "acme"]);
    const dup = sb.run(["add", "acme"]);
    assert.equal(dup.status, 1);
    assert.match(dup.stderr, /account "acme" already exists/);
  });
});

describe("set", () => {
  beforeEach(() => {
    sb.run(["add", "acme"]);
  });

  it("prints and edits the defaults", () => {
    let res = sb.run(["set", "acme"]);
    assert.equal(res.stdout, "acme\n  model   –\n  effort  –\n  args    –\n");
    res = sb.run(["set", "acme", "--model", "opus", "--effort", "xhigh", "--args", "--chrome --add-dir '/a b'"]);
    assert.equal(res.stdout, "acme\n  model   opus\n  effort  xhigh\n  args    --chrome --add-dir '/a b'\n");
    assert.deepEqual(config().accounts.acme, { model: "opus", effort: "xhigh", args: ["--chrome", "--add-dir", "/a b"] });
    sb.run(["set", "acme", "--unset", "model", "--unset=args"]);
    assert.deepEqual(config().accounts.acme, { model: null, effort: "xhigh", args: [] });
  });

  it("turns the main identity on and off", () => {
    let res = sb.run(["set", "main", "--enable"]);
    assert.match(res.stdout, /^main \(enabled: the login in ~\/\.claude\)/);
    assert.equal(config().main.enabled, true);
    assert.equal(sb.run(["main", "-p", "x"]).status, 0);
    assert.equal(sb.fakeCalls().at(-1)!.env.CLAUDE_CONFIG_DIR, undefined);
    res = sb.run(["set", "main", "--disable", "--model", "haiku"]);
    assert.equal(config().main.enabled, false);
    assert.equal(config().main.model, "haiku");
    assert.match(sb.run(["main"]).stderr, /the main identity is disabled; enable it with: xclaude set main --enable/);
  });

  it("rejects bad requests", () => {
    for (const [args, re] of [
      [["set", "acme", "--enable"], /--enable and --disable are for the main identity/],
      [["set", "main", "--enable", "--disable"], /choose --enable or --disable/],
      [["set", "acme", "--unset", "color"], /--unset takes model, effort or args/],
      [["set", "acme", "--model", "x", "--unset", "model"], /contradict/],
      [["set", "acme", "--effort", "huge"], /--effort must be one of/],
      [["set", "nobody"], /unknown account or command "nobody"/],
      [["set"], /usage: xclaude set/],
    ] as const) {
      const res = sb.run([...args]);
      assert.equal(res.status, 2, args.join(" "));
      assert.match(res.stderr, re);
    }
  });
});

describe("ls", () => {
  it("shows logins, defaults and the exact config dir", () => {
    assert.equal(sb.run(["ls"]).stdout, "No accounts yet. Add one with: xclaude add <name>\n");
    sb.run(["add", "acme", "--model", "opus", "--args", "--chrome"], { env: { FAKE_CLAUDE_LOGIN: login("a@acme.com") } });
    sb.run(["add", "personal"]);
    sb.run(["set", "main", "--enable"]);
    const out = sb.run(["ls"]).stdout.split("\n");
    assert.match(out[0]!, /^NAME\s+LOGIN\s+MODEL\s+EFFORT\s+ARGS\s+CONFIG DIR$/);
    assert.match(out[1]!, new RegExp(`^acme\\s+a@acme\\.com \\(Org One\\)\\s+opus\\s+–\\s+--chrome\\s+${accDir("acme")}$`));
    assert.match(out[2]!, new RegExp(`^personal\\s+not logged in\\s+–\\s+–\\s+–\\s+${accDir("personal")}$`));
    assert.match(out[3]!, /^main\s+not logged in .*\.claude \(no CLAUDE_CONFIG_DIR\)$/);
  });
});

describe("rm", () => {
  beforeEach(() => {
    sb.run(["add", "acme"], { env: { FAKE_CLAUDE_LOGIN: login("a@acme.com") } });
    sb.run(["add", "other"], { env: { FAKE_CLAUDE_LOGIN: login("o@other.com", "org-2") } });
    sb.run(["other", "-p", "x"], { cwd: sb.root });
    sb.run(["acme", "-p", "x"], { cwd: sb.root });
  });

  it("stops the supervisor, logs out, keeps only the links in its folder and every shared file", () => {
    fs.writeFileSync(path.join(accDir("acme"), "projects", "keep.jsonl"), "conversation");
    fs.writeFileSync(path.join(sb.store, "history.jsonl"), "prompts\n");
    fs.writeFileSync(`${accDir("acme")}.lock`, "");
    fs.mkdirSync(path.join(accDir("acme"), "backups"));
    fs.writeFileSync(path.join(accDir("acme"), "settings.json"), "{}");
    const res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 0, res.stderr);
    const calls = sb.fakeCalls().filter((c) => c.env.CLAUDE_CONFIG_DIR === accDir("acme"));
    assert.ok(calls.some((c) => c.argv.join(" ") === "daemon stop --any"));
    assert.ok(calls.some((c) => c.argv.join(" ") === "auth logout"));
    // The folder keeps its links, so paths recorded through it (saved tool outputs) still resolve.
    const left = fs.readdirSync(accDir("acme"));
    assert.ok(left.includes("projects") && left.includes("history.jsonl"), left.join(" "));
    assert.ok(left.every((n) => fs.lstatSync(path.join(accDir("acme"), n)).isSymbolicLink()), `only links: ${left.join(" ")}`);
    assert.equal(fs.readFileSync(path.join(accDir("acme"), "projects", "keep.jsonl"), "utf8"), "conversation");
    assert.match(res.stderr, /accounts\/acme keeps only its links into ~\/\.claude, so acme's old conversations can still open their saved long outputs; delete it with: xclaude rm acme/);
    assert.equal(fs.existsSync(`${accDir("acme")}.lock`), false);
    assert.equal(fs.readFileSync(path.join(sb.store, "projects", "keep.jsonl"), "utf8"), "conversation");
    assert.equal(fs.readFileSync(path.join(sb.store, "history.jsonl"), "utf8"), "prompts\n");
    assert.equal(config().accounts.acme, undefined);
    const state = JSON.parse(fs.readFileSync(path.join(sb.xhome, "state.json"), "utf8"));
    assert.equal(state.lastAccountByDir[sb.root], undefined);
    assert.equal(state.lastUsedAccount, null);
    assert.equal(fs.readlinkSync(path.join(accDir("other"), "projects")), path.join(sb.store, "projects"), "other accounts are untouched");
  });

  it("keeps the login with --keep-login", () => {
    sb.run(["rm", "acme", "-y", "--keep-login"]);
    assert.ok(!sb.fakeCalls().some((c) => c.argv.join(" ") === "auth logout"));
  });

  const loggedOut = () => sb.fakeCalls().some((c) => c.argv.join(" ") === "auth logout");

  it("logs out even when another identity has the same email (spike 14)", () => {
    fakeLogin(accDir("other"), { email: "a@acme.com", orgId: "org-9" });
    fakeLogin(sb.store, { email: "a@acme.com", orgId: "org-personal" });
    assert.equal(sb.run(["rm", "acme", "-y"]).status, 0);
    assert.ok(loggedOut());
  });

  describe("with keepSameEmailLogin on", () => {
    const on = { XCLAUDE_SWITCHES: "keepSameEmailLogin=1" };

    it("doesn't log out while another identity has the same email", () => {
      fakeLogin(accDir("other"), { email: "a@acme.com", orgId: "org-9" });
      const res = sb.run(["rm", "acme", "-y"], { env: on });
      assert.equal(res.status, 0);
      assert.match(res.stderr, /not logging acme out: other is logged in with the same email \(a@acme\.com\)/);
      assert.ok(!loggedOut());
    });

    it("doesn't log out when another login can't be read", () => {
      const res = sb.run(["rm", "acme", "-y"], { env: { ...on, FAKE_CLAUDE_AUTH_FAIL: "other" } });
      assert.equal(res.status, 0);
      assert.match(res.stderr, /not logging acme out: couldn't read the login of other, which may use the same email/);
      assert.ok(!loggedOut());
    });

    it("counts the ~/.claude login as the same user even while main is off", () => {
      fakeLogin(sb.store, { email: "a@acme.com", orgId: "org-personal" });
      const res = sb.run(["rm", "acme", "-y"], { env: on });
      assert.match(res.stderr, /not logging acme out: the ~\/\.claude login is logged in with the same email/);
      assert.ok(!loggedOut());
    });
  });

  it("doesn't log out when its own login can't be read", () => {
    const res = sb.run(["rm", "acme", "-y"], { env: { FAKE_CLAUDE_AUTH_FAIL: "acme" } });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /couldn't read acme's login .* so it isn't logged out; its login may remain/);
    assert.ok(!loggedOut());
  });

  it("deletes a removed account's leftover folder when run on the name again", () => {
    sb.run(["rm", "acme", "-y"]);
    let res = sb.run(["rm", "acme"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /deleting leftover folders needs a confirmation: run it in a terminal, or pass -y/);
    res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /deleted ~\/\.xclaude\/accounts\/acme/);
    assert.equal(fs.existsSync(accDir("acme")), false);
    assert.ok(fs.existsSync(path.join(sb.store, "projects")), "the store stays");
    res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown account or command "acme"/);
  });

  it("deletes every leftover with --leftovers, but not one holding real content", () => {
    assert.match(sb.run(["rm", "--leftovers", "-y"]).stderr, /no leftover folders/);
    sb.run(["rm", "acme", "-y"]);
    sb.run(["rm", "other", "-y"]);
    // A real folder where a link was: it may hold conversations, so it's left alone.
    fs.rmSync(path.join(accDir("other"), "plans"));
    fs.mkdirSync(path.join(accDir("other"), "plans"));
    fs.writeFileSync(path.join(accDir("other"), "plans", "plan.md"), "the plan");
    let res = sb.run(["rm", "--leftovers", "-y"]);
    assert.equal(res.status, 1);
    assert.equal(fs.existsSync(accDir("acme")), false);
    assert.match(res.stderr, /not deleting ~\/\.xclaude\/accounts\/other: it holds more than links \(plans\)\. `xclaude add other` takes it back as an account, merging shared content into ~\/\.claude/);
    assert.equal(fs.readFileSync(path.join(accDir("other"), "plans", "plan.md"), "utf8"), "the plan");
    // Adding the account back merges it into ~/.claude; then the leftover goes.
    sb.run(["add", "other"]);
    assert.equal(fs.readFileSync(path.join(sb.store, "plans", "plan.md"), "utf8"), "the plan");
    sb.run(["rm", "other", "-y"]);
    res = sb.run(["rm", "--leftovers", "-y"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(accDir("other")), false);
    assert.equal(sb.run(["rm", "--leftovers", "acme"]).status, 2);
  });

  it("deletes only folders that hold nothing but links", () => {
    const folder = (name: string, files: Record<string, string>) => {
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(accDir(name), rel)), { recursive: true });
        fs.writeFileSync(path.join(accDir(name), rel), text);
      }
    };
    folder("work", { ".credentials.json": "{}", ".claude.json": "{}" }); // a config entry lost, say
    folder("halfway", { ".xclaude-merge-projects-1-2-3/p/t.jsonl": "the only copy" });
    folder("work.bak", { "notes.txt": "a copy" });
    folder("Foo", { "x": "y" });
    const res = sb.run(["rm", "--leftovers", "-y"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not deleting ~\/\.xclaude\/accounts\/work: it holds more than links \(\.claude\.json, \.credentials\.json\)/);
    assert.match(res.stderr, /not deleting ~\/\.xclaude\/accounts\/halfway: it holds more than links \(\.xclaude-merge-projects-1-2-3\)/);
    assert.match(res.stderr, /not deleting ~\/\.xclaude\/accounts\/work\.bak: that name couldn't be an account's/);
    for (const name of ["work", "halfway", "work.bak", "Foo"]) assert.ok(fs.existsSync(accDir(name)), name);
    assert.equal(sb.run(["rm", "work", "-y"]).status, 1);
    assert.equal(fs.readFileSync(path.join(accDir("halfway"), ".xclaude-merge-projects-1-2-3", "p", "t.jsonl"), "utf8"), "the only copy");
  });

  it("leaves a symlinked account folder alone", () => {
    const elsewhere = path.join(sb.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "keep.txt"), "mine");
    fs.rmSync(accDir("acme"), { recursive: true });
    fs.symlinkSync(elsewhere, accDir("acme"));
    let res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not removing acme: ~\/\.xclaude\/accounts\/acme is a symlink/);
    assert.deepEqual(fs.readdirSync(elsewhere), ["keep.txt"]);
    // One pointing at ~/.claude would have every entry linked to itself.
    fs.mkdirSync(path.join(sb.store, "skills", "mine"), { recursive: true });
    fs.symlinkSync(sb.store, accDir("personal"));
    res = sb.run(["add", "personal"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not adding personal: ~\/\.xclaude\/accounts\/personal is a symlink/);
    assert.ok(fs.lstatSync(path.join(sb.store, "skills")).isDirectory() && !fs.lstatSync(path.join(sb.store, "skills")).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(sb.store, "skills", "mine")));
    assert.equal(config().accounts.personal, undefined);
  });

  it("removes an account whose folder is already gone without making a new one", () => {
    fs.rmSync(accDir("acme"), { recursive: true });
    const res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /removed acme; its folder was already gone/);
    assert.equal(fs.existsSync(accDir("acme")), false);
    assert.equal(config().accounts.acme, undefined);
  });

  it("keeps an account's own content under a name that isn't shared", () => {
    const cfg = config();
    cfg.share.remove = ["skills"];
    fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify(cfg));
    sb.run(["acme", "-p", "x"], { cwd: sb.root }); // the launch turns skills into acme's own folder
    fs.mkdirSync(path.join(accDir("acme"), "skills", "mine"));
    fs.writeFileSync(path.join(accDir("acme"), "skills", "mine", "SKILL.md"), "my skill");
    const res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /and acme's own skills \(not shared\)\. Move what you want to keep; then `xclaude rm acme` deletes the rest/);
    assert.equal(fs.readFileSync(path.join(accDir("acme"), "skills", "mine", "SKILL.md"), "utf8"), "my skill");
    assert.equal(sb.run(["rm", "acme", "-y"]).status, 1, "not deleted while it holds that");
  });

  it("keeps a leftover while tmux sessions of its account still run", (t) => {
    if (!needTmux(sb, t)) return;
    sb.run(["tmux", "new", "busy", "--detach", "acme"]);
    assert.match(sb.run(["rm", "acme", "-y"]).stderr, /tmux sessions still running on acme \(left alone\): busy/);
    const res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not deleting ~\/\.xclaude\/accounts\/acme: tmux sessions of acme still run \(busy\); end them first/);
    assert.ok(fs.existsSync(accDir("acme")));
  });

  it("exits 130 when the confirmation is declined", async (t) => {
    if (!needTmux(sb, t)) return;
    const status = path.join(sb.root, "status");
    startPane(sb, "rm", `xclaude rm acme; echo $? > ${status}`);
    await waitFor(() => capture(sb, "rm").includes("[y/N]"), "the question");
    tmux(sb, ["send-keys", "-t", "rm", "n", "Enter"]);
    await waitFor(() => fs.existsSync(status), "rm to finish");
    assert.equal(fs.readFileSync(status, "utf8").trim(), "130");
    assert.ok(fs.existsSync(accDir("acme")), "nothing removed");
  });

  it("refuses while a shared entry isn't a correct link", () => {
    fs.rmSync(path.join(accDir("acme"), "skills"));
    fs.writeFileSync(path.join(accDir("acme"), "skills"), "a file where a link belongs");
    const res = sb.run(["rm", "acme", "-y"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not removing acme: its links aren't all in place/);
    assert.ok(fs.existsSync(accDir("acme")));
    assert.ok(config().accounts.acme);
  });

  it("merges a left-behind real directory before deleting", () => {
    fs.rmSync(path.join(accDir("acme"), "plans"));
    fs.mkdirSync(path.join(accDir("acme"), "plans"));
    fs.writeFileSync(path.join(accDir("acme"), "plans", "plan.md"), "the plan");
    assert.equal(sb.run(["rm", "acme", "-y"]).status, 0);
    assert.equal(fs.readFileSync(path.join(sb.store, "plans", "plan.md"), "utf8"), "the plan");
  });

  it("needs a confirmation or -y, and never removes main", () => {
    let res = sb.run(["rm", "acme"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /needs a confirmation: run it in a terminal, or pass -y/);
    res = sb.run(["rm", "main", "-y"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /main identity isn't removable/);
    assert.ok(fs.existsSync(accDir("acme")));
  });
});
