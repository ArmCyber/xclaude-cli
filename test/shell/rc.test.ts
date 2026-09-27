// The rc block on fixtures.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { blockFor, dquote, END, rcTargets, removeBlock, sourcesBashrc, START, upsertBlock, writeRc } from "../../src/shell/rc.ts";
import { removeTemp, tempDir } from "../helpers/tmp.ts";

const block = blockFor("/home/u/.xclaude/shell/init.zsh");

describe("rc block text", () => {
  it("has the exact text", () => {
    assert.equal(
      block,
      `# >>> xclaude >>>\n# Managed by \`xclaude shell install\`. Remove with \`xclaude shell uninstall\`.\n[ -f "/home/u/.xclaude/shell/init.zsh" ] && . "/home/u/.xclaude/shell/init.zsh"\n# <<< xclaude <<<\n`,
    );
    assert.equal(dquote(`/a "b" $c \`d\` \\e`), `"/a \\"b\\" \\$c \\\`d\\\` \\\\e"`);
  });

  it("is appended once and replaced in place on re-runs", () => {
    assert.equal(upsertBlock("", block, "rc"), block);
    const rc = "export A=1\n";
    const once = upsertBlock(rc, block, "rc");
    assert.equal(once, `export A=1\n\n${block}`);
    const other = blockFor("/elsewhere/init.zsh");
    const twice = upsertBlock(`${once}alias x=y\n`, other, "rc");
    assert.equal(twice, `export A=1\n\n${other}alias x=y\n`, "replaced where it was, nothing duplicated");
    assert.equal(twice.split(START).length, 2);
    assert.equal(upsertBlock("no newline", block, "rc"), `no newline\n\n${block}`);
  });

  it("is removed with the blank line install added", () => {
    const rc = upsertBlock("export A=1\n", block, "rc");
    assert.deepEqual(removeBlock(rc, "rc"), { text: "export A=1\n", found: true });
    assert.deepEqual(removeBlock("export A=1\n", "rc"), { text: "export A=1\n", found: false });
    const middle = `a\n${block}b\n`;
    assert.equal(removeBlock(middle, "rc").text, "a\nb\n");
  });

  it("refuses a start marker without an end marker", () => {
    const broken = `a\n${START}\nsomething\n`;
    assert.throws(() => upsertBlock(broken, block, "~/.zshrc"), /~\/\.zshrc has "# >>> xclaude >>>" without "# <<< xclaude <<<"/);
    assert.throws(() => removeBlock(broken, "~/.zshrc"), /without/);
    assert.ok(END);
  });

  it("recognizes a bash_profile that sources ~/.bashrc", () => {
    for (const yes of [". ~/.bashrc", "source ~/.bashrc", '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"', "if [ -f ~/.bashrc ]; then source ~/.bashrc; fi"]) {
      assert.ok(sourcesBashrc(yes), yes);
    }
    for (const no of ["# . ~/.bashrc", "export BASHRC=~/.bashrc", "echo .bashrc"]) assert.ok(!sourcesBashrc(no), no);
  });
});

describe("rc targets and writes", () => {
  let root: string;
  let home: string;
  beforeEach(() => {
    root = tempDir();
    home = path.join(root, "home");
    fs.mkdirSync(home);
  });
  afterEach(() => removeTemp(root));

  const files = (ts: Array<{ shell: string; file: string }>) => ts.map((t) => `${t.shell}:${path.relative(root, t.file)}`);

  it("targets whichever rc files exist, or the ones asked for", () => {
    assert.deepEqual(rcTargets({}, home, "linux", {}), []);
    fs.writeFileSync(path.join(home, ".bashrc"), "");
    assert.deepEqual(files(rcTargets({}, home, "linux", {})), ["bash:home/.bashrc"]);
    fs.writeFileSync(path.join(home, ".zshrc"), "");
    assert.deepEqual(files(rcTargets({}, home, "linux", {})), ["zsh:home/.zshrc", "bash:home/.bashrc"]);
    assert.deepEqual(files(rcTargets({}, home, "linux", { zsh: true })), ["zsh:home/.zshrc"]);
    fs.mkdirSync(path.join(root, "zdot"));
    assert.deepEqual(files(rcTargets({ ZDOTDIR: path.join(root, "zdot") }, home, "linux", { zsh: true })), ["zsh:zdot/.zshrc"]);
  });

  it("adds ~/.bash_profile on macOS when it doesn't source ~/.bashrc", () => {
    fs.writeFileSync(path.join(home, ".bashrc"), "");
    assert.deepEqual(files(rcTargets({}, home, "darwin", {})), ["bash:home/.bashrc"], "no bash_profile, none created");
    fs.writeFileSync(path.join(home, ".bash_profile"), "export PATH=/x:$PATH\n");
    assert.deepEqual(files(rcTargets({}, home, "darwin", {})), ["bash:home/.bashrc", "bash:home/.bash_profile"]);
    assert.deepEqual(files(rcTargets({}, home, "linux", {})), ["bash:home/.bashrc"]);
    fs.writeFileSync(path.join(home, ".bash_profile"), "[ -f ~/.bashrc ] && . ~/.bashrc\n");
    assert.deepEqual(files(rcTargets({}, home, "darwin", {})), ["bash:home/.bashrc"]);
  });

  it("edits a symlinked rc file at its target, keeping the link", () => {
    const dot = path.join(root, "dotfiles", "zshrc");
    fs.mkdirSync(path.dirname(dot));
    fs.writeFileSync(dot, "export A=1\n", { mode: 0o640 });
    const rc = path.join(home, ".zshrc");
    fs.symlinkSync(dot, rc);
    const res = writeRc(rc, upsertBlock("export A=1\n", block, "rc"), "export A=1\n");
    assert.equal(res.status, "written");
    assert.ok(fs.lstatSync(rc).isSymbolicLink());
    assert.match(fs.readFileSync(dot, "utf8"), /# >>> xclaude >>>/);
    assert.equal(fs.statSync(dot).mode & 0o777, 0o640);
  });

  it("asks for a manual edit when the file isn't writable", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores permissions");
      return;
    }
    const ro = path.join(root, "store");
    fs.mkdirSync(ro);
    fs.writeFileSync(path.join(ro, "zshrc"), "x\n");
    fs.chmodSync(path.join(ro, "zshrc"), 0o444);
    fs.chmodSync(ro, 0o555);
    fs.symlinkSync(path.join(ro, "zshrc"), path.join(home, ".zshrc"));
    const res = writeRc(path.join(home, ".zshrc"), "x\nnew\n", "x\n");
    assert.equal(res.status, "manual");
    assert.equal(fs.readFileSync(path.join(ro, "zshrc"), "utf8"), "x\n");
    assert.equal(writeRc(path.join(home, ".zshrc"), "x\n", "x\n").status, "unchanged");
  });

  it("never replaces a symlinked rc file whose target doesn't exist yet", () => {
    const rc = path.join(home, ".zshrc");
    fs.symlinkSync(path.join(root, "dotfiles-not-cloned", "zshrc"), rc);
    assert.equal(writeRc(rc, block, null).status, "manual");
    assert.ok(fs.lstatSync(rc).isSymbolicLink());
  });

  it("creates a missing rc file with mode 0644", () => {
    const rc = path.join(home, ".zshrc");
    assert.equal(writeRc(rc, block, null).status, "written");
    assert.equal(fs.statSync(rc).mode & 0o777, 0o644);
  });
});
