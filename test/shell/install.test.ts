// Generated init files and `xclaude shell install|uninstall`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initBash, initZsh } from "../../src/shell/init.ts";
import { makeSandbox, missingTool, type Sandbox } from "../helpers/sandbox.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

const hasZsh = () => fs.existsSync(path.join(sb.bin, "zsh"));

describe("generated init files", () => {
  for (const guard of [false, true]) {
    it(`pass bash -n and zsh -n (guard ${guard ? "on" : "off"})`, (t) => {
      const bash = path.join(sb.root, "init.bash");
      const zsh = path.join(sb.root, "init.zsh");
      fs.writeFileSync(bash, initBash("9.9.9", guard));
      fs.writeFileSync(zsh, initZsh("9.9.9", guard));
      const b = sb.spawn("/bin/bash", ["-n", bash]);
      assert.equal(b.status, 0, b.stderr);
      if (!hasZsh()) {
        t.diagnostic(missingTool("zsh"));
        return;
      }
      const z = sb.spawn(path.join(sb.bin, "zsh"), ["-n", zsh]);
      assert.equal(z.status, 0, z.stderr);
    });
  }

  it("contain the guard only when it's on", () => {
    assert.doesNotMatch(initBash("1", false), /claude\(\)/);
    assert.match(initBash("1", true), /^claude\(\) \{$/m);
    assert.match(initZsh("1", true), /^unalias claude 2>\/dev\/null$/m);
  });
});

describe("shell install and uninstall", () => {
  const rc = (name: string) => path.join(sb.home, name);
  const read = (name: string) => fs.readFileSync(rc(name), "utf8");

  it("adds the block to the existing rc files and writes the init files", () => {
    fs.writeFileSync(rc(".zshrc"), "export A=1\n");
    fs.writeFileSync(rc(".bashrc"), "export B=2\n");
    const res = sb.run(["shell", "install"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /updated ~\/\.zshrc\n.*updated ~\/\.bashrc\n/s);
    assert.equal(read(".zshrc"), `export A=1\n\n# >>> xclaude >>>\n# Managed by \`xclaude shell install\`. Remove with \`xclaude shell uninstall\`.\n[ -f "${sb.xhome}/shell/init.zsh" ] && . "${sb.xhome}/shell/init.zsh"\n# <<< xclaude <<<\n`);
    assert.match(read(".bashrc"), /init\.bash"\n# <<< xclaude <<<\n$/);
    for (const f of ["init.bash", "init.zsh"]) assert.ok(fs.existsSync(path.join(sb.xhome, "shell", f)), f);
    // Re-running changes nothing.
    const again = sb.run(["shell", "install"]);
    assert.match(again.stderr, /~\/\.zshrc is already set up/);
    assert.equal(read(".zshrc").split("# >>> xclaude >>>").length, 2);
  });

  it("needs an rc file, or an explicit shell that creates one", () => {
    let res = sb.run(["shell", "install"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /neither ~\/\.zshrc nor ~\/\.bashrc exists; pick one with --zsh or --bash/);
    res = sb.run(["shell", "install", "--zsh"]);
    assert.equal(res.status, 0);
    assert.match(read(".zshrc"), /^# >>> xclaude >>>/);
    assert.equal(fs.existsSync(rc(".bashrc")), false);
  });

  it("honors ZDOTDIR", () => {
    const zdot = path.join(sb.root, "zdot");
    fs.mkdirSync(zdot);
    fs.writeFileSync(path.join(zdot, ".zshrc"), "");
    sb.run(["shell", "install"], { env: { ZDOTDIR: zdot } });
    assert.match(fs.readFileSync(path.join(zdot, ".zshrc"), "utf8"), /init\.zsh/);
    assert.equal(fs.existsSync(rc(".zshrc")), false);
  });

  it("aborts on a broken block", () => {
    fs.writeFileSync(rc(".zshrc"), "# >>> xclaude >>>\nhalf a block\n");
    const res = sb.run(["shell", "install"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /without "# <<< xclaude <<<"/);
  });

  it("removes the block and the init files", () => {
    fs.writeFileSync(rc(".zshrc"), "export A=1\n");
    fs.writeFileSync(rc(".bashrc"), "export B=2\n");
    sb.run(["shell", "install"]);
    const res = sb.run(["shell", "uninstall"]);
    assert.equal(res.status, 0);
    assert.equal(read(".zshrc"), "export A=1\n");
    assert.equal(read(".bashrc"), "export B=2\n");
    assert.equal(fs.existsSync(path.join(sb.xhome, "shell")), false);
    assert.match(sb.run(["shell", "uninstall"]).stderr, /no shell block was installed/);
  });

  it("asks for a manual removal from a read-only rc file, without claiming there was none", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root ignores permissions");
      return;
    }
    fs.writeFileSync(rc(".bashrc"), "export B=2\n");
    sb.run(["shell", "install", "--bash"]);
    fs.chmodSync(rc(".bashrc"), 0o444);
    fs.chmodSync(sb.home, 0o555);
    try {
      const res = sb.run(["shell", "uninstall", "--bash"]);
      assert.match(res.stderr, /\.bashrc isn't writable; remove the xclaude block from it by hand/);
      assert.doesNotMatch(res.stderr, /no shell block was installed/);
    } finally {
      fs.chmodSync(sb.home, 0o755);
    }
  });

  it("is a no-op in the shell once xclaude is gone", () => {
    fs.writeFileSync(rc(".bashrc"), "");
    sb.run(["shell", "install"]);
    const res = sb.spawn("/bin/bash", ["-c", `. ~/.bashrc; type _xclaude_complete >/dev/null 2>&1 && echo defined || echo absent`], {
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.equal(res.stdout.trim(), "absent");
    const present = sb.spawn("/bin/bash", ["-c", ". ~/.bashrc; complete -p xclaude"]);
    assert.match(present.stdout, /complete -o nospace -F _xclaude_complete xclaude/);
  });

  it("regenerates the init files on the first run after an update", () => {
    fs.writeFileSync(rc(".bashrc"), "");
    sb.run(["shell", "install"]);
    const init = path.join(sb.xhome, "shell", "init.bash");
    fs.writeFileSync(init, "# stale\n");
    const state = path.join(sb.xhome, "state.json");
    fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, "utf8")), installedVersion: "0.0.0-old" }));
    sb.run(["ls"]);
    assert.match(fs.readFileSync(init, "utf8"), /_xclaude_complete/);
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).installedVersion, pkg.version);
    // The rc file itself is never touched again.
    assert.equal(fs.readFileSync(rc(".bashrc"), "utf8").split("# >>> xclaude >>>").length, 2);
  });
});
