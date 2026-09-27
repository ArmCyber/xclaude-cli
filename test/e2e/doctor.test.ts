// xclaude doctor [--fix]: one fixture per finding.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fakeLogin, makeSandbox, type Sandbox } from "../helpers/sandbox.ts";

let sb: Sandbox;
const login = (email: string, orgId = "org-1", orgName = "Org One") => JSON.stringify({ email, orgId, orgName });
const accDir = (name: string) => path.join(sb.xhome, "accounts", name);

beforeEach(() => {
  sb = makeSandbox();
  fs.writeFileSync(path.join(sb.home, ".bashrc"), "");
  sb.run(["add", "acme"], { env: { FAKE_CLAUDE_LOGIN: login("a@acme.com") } });
  sb.run(["shell", "install"]);
});
afterEach(() => sb.cleanup());

const doctor = (args: string[] = [], env: Record<string, string | undefined> = {}) => sb.run(["doctor", ...args], { env });

describe("doctor", () => {
  it("passes on a healthy setup", () => {
    const res = doctor();
    assert.equal(res.status, 0, res.stdout);
    assert.match(res.stdout, /^Tools\n {2}✓ claude 2\.1\.282 \(Claude Code\) at /);
    assert.match(res.stdout, /✓ tmux \d+\.\d+/);
    assert.match(res.stdout, /✓ Node \d+/);
    assert.match(res.stdout, /Config\n {2}✓ ~\/\.xclaude\/config\.json/);
    assert.match(res.stdout, /Accounts\n {2}acme {2}a@acme\.com \(Org One\)\n {4}✓ links into ~\/\.claude/);
    assert.match(res.stdout, /Shell\n {2}✓ completion loaded from ~\/\.bashrc\n {2}· guard: off/);
    assert.match(res.stdout, /Environment\n {2}✓ nothing that overrides accounts/);
    assert.match(res.stdout, /\nAll good\.\n$/);
  });

  it("reports a missing claude and a missing tmux", () => {
    const res = doctor([], { XCLAUDE_CLAUDE_PATH: undefined, PATH: path.dirname(process.execPath) });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /✗ Claude Code isn't installed; install it with: curl/);
    assert.match(res.stdout, /! tmux isn't installed, so xclaude tmux won't work/);
  });

  it("reports an invalid config and keeps going", () => {
    fs.writeFileSync(path.join(sb.xhome, "config.json"), '{"accounts": {"Bad": {}}}');
    const res = doctor();
    assert.equal(res.status, 1);
    assert.match(res.stdout, /Config\n {2}✗ ~\/\.xclaude\/config\.json: accounts: "Bad" isn't a valid account name/);
    assert.match(res.stdout, /\nShell\n/);
    assert.match(res.stdout, /Accounts\n {2}· not checked: fix the config first/);
    assert.doesNotMatch(res.stdout, /isn't in the config/, "real accounts are never called orphans");
  });

  it("reports link problems and repairs them with --fix", () => {
    fs.unlinkSync(path.join(accDir("acme"), "skills"));
    fs.symlinkSync("/somewhere/else", path.join(accDir("acme"), "skills"));
    fs.unlinkSync(path.join(accDir("acme"), "plans"));
    fs.mkdirSync(path.join(accDir("acme"), "plans"));
    fs.writeFileSync(path.join(accDir("acme"), "plans", "p.md"), "plan");
    let res = doctor();
    assert.equal(res.status, 1);
    assert.match(res.stdout, /✗ skills links to \/somewhere\/else, not ~\/\.claude\/skills; `xclaude doctor --fix` replaces the link/);
    assert.match(res.stdout, /✗ plans not repaired yet; run `xclaude doctor --fix`/);
    assert.match(res.stdout, /2 problems, 0 warnings\. Run `xclaude doctor --fix` to repair what can be repaired\./);
    res = doctor(["--fix"]);
    assert.equal(res.status, 0, res.stdout);
    assert.match(res.stderr, /acme\/skills pointed to \/somewhere\/else; relinked to ~\/\.claude\/skills/);
    assert.match(res.stderr, /merged acme\/plans into ~\/\.claude\/plans: 1 moved/);
    assert.equal(fs.readlinkSync(path.join(accDir("acme"), "skills")), path.join(sb.store, "skills"));
  });

  it("reports a missing account dir, and --fix recreates it", () => {
    fs.rmSync(accDir("acme"), { recursive: true });
    assert.match(doctor().stdout, /✗ ~\/\.xclaude\/accounts\/acme is missing; the next launch \(or --fix\) recreates it/);
    doctor(["--fix"]);
    assert.ok(fs.existsSync(path.join(accDir("acme"), "projects")));
  });

  it("reports the CLAUDE.md stub", () => {
    fs.writeFileSync(path.join(sb.store, "CLAUDE.md"), "# shared\n");
    assert.match(doctor().stdout, /✗ the CLAUDE\.md stub needs creating; run xclaude doctor --fix/);
    doctor(["--fix"]);
    assert.equal(doctor().status, 0);
    fs.writeFileSync(path.join(accDir("acme"), "CLAUDE.md"), "my own rules\n");
    const res = doctor();
    assert.equal(res.status, 0);
    assert.match(res.stdout, /! CLAUDE\.md isn't the import stub, so it's left alone/);
  });

  it("lists unknown entries in the account and in the store", () => {
    fs.mkdirSync(path.join(accDir("acme"), "newthing"));
    fs.writeFileSync(path.join(sb.store, "mystery"), "");
    const res = doctor();
    assert.equal(res.status, 0);
    assert.match(res.stdout, /· per-account entries xclaude doesn't know: newthing/);
    assert.match(res.stdout, /· entries in ~\/\.claude that no account links to: mystery/);
  });

  it("warns about missing and duplicate logins", () => {
    sb.run(["add", "twin"], { env: { FAKE_CLAUDE_LOGIN: login("a@acme.com") } });
    sb.run(["add", "nobody"]);
    const res = doctor();
    assert.equal(res.status, 0);
    assert.match(res.stdout, /nobody {2}not logged in\n(.*\n)* {4}! not logged in; run: xclaude nobody auth login/);
    assert.match(res.stdout, /! acme and twin use the same login \(a@acme\.com\)/);
  });

  it("reads forceLoginOrgUUID from every managed source", () => {
    const managed = path.join(sb.root, "managed");
    fs.mkdirSync(path.join(managed, "managed-settings.d"), { recursive: true });
    fs.writeFileSync(path.join(managed, "managed-settings.json"), JSON.stringify({ forceLoginOrgUUID: ["org-1", "org-7"] }));
    assert.equal(doctor().status, 0, "org-1 is allowed");
    fs.writeFileSync(path.join(managed, "managed-settings.d", "10-lock.json"), JSON.stringify({ forceLoginOrgUUID: "org-9" }));
    const res = doctor();
    assert.equal(res.status, 1, "a single value replaces the list");
    assert.match(res.stdout, /✗ forceLoginOrgUUID \(from .*managed-settings\.d\/10-lock\.json\) excludes this login's organization \(Org One\), so it will be refused/);
    // A later list adds to an earlier list, and replaces a single value.
    fs.writeFileSync(path.join(managed, "managed-settings.d", "20-more.json"), JSON.stringify({ forceLoginOrgUUID: ["org-1"] }));
    assert.equal(doctor().status, 0);
    fs.writeFileSync(path.join(managed, "managed-settings.d", "10-lock.json"), JSON.stringify({ forceLoginOrgUUID: ["org-9"] }));
    assert.equal(doctor().status, 0, "lists combine: org-1 is allowed");
  });

  it("warns about a short server-managed retention", () => {
    fs.writeFileSync(path.join(accDir("acme"), "remote-settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
    fs.writeFileSync(path.join(sb.store, "remote-settings.json"), JSON.stringify({ cleanupPeriodDays: 3 }));
    const res = doctor();
    assert.equal(res.status, 0);
    assert.match(res.stdout, /! its organization sets cleanupPeriodDays to 7: its sessions delete everyone's shared transcripts older than 7 days/);
    assert.match(res.stdout, /! the ~\/\.claude login's organization sets cleanupPeriodDays to 3: plain claude deletes/);
  });

  it("warns about environment overrides", () => {
    const res = doctor([], { CLAUDE_CONFIG_DIR: "/somewhere", CLAUDE_CODE_EFFORT_LEVEL: "low" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /! CLAUDE_CONFIG_DIR is set \(\/somewhere\), so plain `claude` doesn't use ~\/\.claude/);
    assert.match(res.stdout, /! CLAUDE_CODE_EFFORT_LEVEL is set \(low\); it overrides the effort level saved in every account's settings/);
  });

  it("notes removed accounts' leftover folders, and warns about folders that aren't one", () => {
    fs.mkdirSync(path.join(sb.xhome, "accounts", "old"));
    fs.symlinkSync(sb.store, path.join(sb.xhome, "accounts", "old", "projects"));
    fs.mkdirSync(path.join(sb.xhome, "accounts", "stray", "projects"), { recursive: true });
    fs.mkdirSync(path.join(sb.xhome, "accounts", "work.bak"));
    fs.symlinkSync(sb.root, path.join(sb.xhome, "accounts", "linked"));
    fs.writeFileSync(path.join(sb.xhome, "accounts", "acme.lock"), "");
    const res = doctor();
    assert.match(res.stdout, /· ~\/\.xclaude\/accounts\/old: links kept from the removed account old, for its old conversations; delete with: xclaude rm old/);
    assert.match(res.stdout, /! ~\/\.xclaude\/accounts\/stray isn't an account but holds more than links \(projects\): `xclaude add stray` takes it back/);
    assert.match(res.stdout, /· ~\/\.xclaude\/accounts\/work\.bak isn't an account folder \(that name couldn't be one\)/);
    assert.match(res.stdout, /! ~\/\.xclaude\/accounts\/linked is a symlink; xclaude only manages real folders there/);
    assert.doesNotMatch(res.stdout, /acme\.lock/);
  });

  it("warns about refused share.add names and unwritable store entries", (t) => {
    const cfg = JSON.parse(fs.readFileSync(path.join(sb.xhome, "config.json"), "utf8"));
    cfg.share.add = ["Jobs"];
    fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify(cfg));
    assert.match(doctor().stdout, /! share\.add "Jobs" is ignored/);
    if (process.getuid?.() === 0) {
      t.skip("root ignores permissions");
      return;
    }
    fs.chmodSync(path.join(sb.store, "skills"), 0o555);
    try {
      assert.match(doctor().stdout, /! ~\/\.claude\/skills isn't writable/);
    } finally {
      fs.chmodSync(path.join(sb.store, "skills"), 0o755);
    }
  });

  it("explains a store and account dir on different filesystems", (t) => {
    const other = "/dev/shm";
    if (!fs.existsSync(other) || fs.statSync(other).dev === fs.statSync(os.tmpdir()).dev) {
      t.skip("needs a second filesystem (/dev/shm)");
      return;
    }
    const xhome = fs.mkdtempSync(path.join(other, "xclaude-test-"));
    try {
      fs.cpSync(path.join(sb.xhome, "config.json"), path.join(xhome, "config.json"));
      const env = { XCLAUDE_HOME: xhome };
      sb.run(["acme", "-p", "x"], { env });
      const res = doctor([], env);
      assert.match(res.stdout, /! ~\/\.claude and .*accounts\/acme are on different filesystems, so left-behind directories can't be merged/);
    } finally {
      fs.rmSync(xhome, { recursive: true, force: true });
    }
  });

  it("normalizes plugin registry paths with --fix when switched on", () => {
    const registry = path.join(sb.store, "plugins", "installed_plugins.json");
    fs.writeFileSync(registry, JSON.stringify({ plugins: { "p@m": [{ installPath: `${accDir("acme")}/plugins/cache/m/p/1.0.0` }] } }));
    doctor(["--fix"]);
    assert.match(fs.readFileSync(registry, "utf8"), /xclaude\/accounts\/acme/, "off by default");
    const res = doctor(["--fix"], { XCLAUDE_SWITCHES: "normalizePaths=1" });
    assert.match(res.stderr, /rewrote 1 account-dir path in ~\/\.claude\/plugins\/installed_plugins\.json/);
    assert.equal(JSON.parse(fs.readFileSync(registry, "utf8")).plugins["p@m"][0].installPath, `${sb.store}/plugins/cache/m/p/1.0.0`);
    fakeLogin(accDir("acme"), { email: "a@acme.com", orgId: "org-1" });
  });

  it("rejects stray arguments", () => {
    assert.equal(doctor(["now"]).status, 2);
    assert.match(sb.run(["doctor", "--help"]).stdout, /^Usage: xclaude doctor/);
  });
});
