// The guard, __names, and `xclaude shell completion`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeSandbox, missingTool, type Sandbox } from "../helpers/sandbox.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
  fs.mkdirSync(sb.xhome, { recursive: true });
  fs.writeFileSync(path.join(sb.xhome, "config.json"), JSON.stringify({ accounts: { acme: {}, beta: {} } }));
  fs.writeFileSync(path.join(sb.home, ".bashrc"), "");
  fs.writeFileSync(path.join(sb.home, ".zshrc"), "");
});
afterEach(() => sb.cleanup());

const config = () => JSON.parse(fs.readFileSync(path.join(sb.xhome, "config.json"), "utf8"));

/** Runs `claude -p hi` in a shell that sourced the init file. */
function runClaude(shell: "bash" | "zsh", env: Record<string, string | undefined> = {}) {
  const bin = shell === "bash" ? "/bin/bash" : path.join(sb.bin, "zsh");
  const init = path.join(sb.xhome, "shell", `init.${shell}`);
  const args = shell === "bash" ? ["-c", `. ${init}; claude -p hi`] : ["-f", "-c", `. ${init}; claude -p hi`];
  return sb.spawn(bin, args, { env });
}

describe("guard", () => {
  it("toggles the config and the init files, and reports its status", () => {
    assert.match(sb.run(["guard", "status"]).stdout, /guard: off\nshell integration: not installed \(xclaude shell install\)/);
    let res = sb.run(["guard", "on"]);
    assert.match(res.stderr, /the shell block isn't installed yet/);
    sb.run(["shell", "install"]);
    res = sb.run(["guard", "on"]);
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stderr, /isn't installed/);
    assert.equal(config().guard, true);
    assert.match(fs.readFileSync(path.join(sb.xhome, "shell", "init.bash"), "utf8"), /^claude\(\) \{/m);
    assert.match(sb.run(["guard"]).stdout, /guard: on\nshell integration: installed in ~\/\.zshrc, ~\/\.bashrc/);
    sb.run(["guard", "off"]);
    assert.equal(config().guard, false);
    assert.doesNotMatch(fs.readFileSync(path.join(sb.xhome, "shell", "init.zsh"), "utf8"), /claude\(\)/);
    assert.equal(sb.run(["guard", "maybe"]).status, 2);
  });

  for (const shell of ["bash", "zsh"] as const) {
    it(`blocks bare claude in ${shell}, except inside Claude Code or xclaude`, (t) => {
      if (shell === "zsh" && !fs.existsSync(path.join(sb.bin, "zsh"))) {
        t.skip(missingTool("zsh"));
        return;
      }
      sb.run(["shell", "install"]);
      sb.run(["guard", "on"]);
      const blocked = runClaude(shell);
      assert.equal(blocked.status, 1);
      assert.equal(blocked.stderr, "claude is disabled — use: xclaude <account>   (accounts: acme beta)\n");
      assert.equal(sb.fakeCalls().length, 0);

      for (const env of [{ XCLAUDE_ACCOUNT: "acme" }, { CLAUDE_CODE_CHILD_SESSION: "1" }]) {
        const passed = runClaude(shell, env);
        assert.equal(passed.status, 0, JSON.stringify(env));
      }
      assert.equal(sb.fakeCalls().length, 2);
      assert.deepEqual(sb.fakeCalls()[0]!.argv, ["-p", "hi"]);

      // Without xclaude installed the init file does nothing, so claude just works.
      const plain = runClaude(shell, { PATH: [sb.root, "/usr/bin", "/bin"].join(":") });
      assert.notEqual(plain.stderr.includes("claude is disabled"), true);
    });
  }

  it("keeps a claude alias from breaking the function", () => {
    sb.run(["shell", "install"]);
    sb.run(["guard", "on"]);
    const init = path.join(sb.xhome, "shell", "init.bash");
    const res = sb.spawn("/bin/bash", ["-c", `shopt -s expand_aliases; alias claude=/nonexistent; . ${init}; type -t claude`]);
    assert.equal(res.stdout.trim(), "function");
  });
});

describe("__names and shell completion", () => {
  it("lists the enabled identities without creating anything", () => {
    assert.equal(sb.run(["__names"]).stdout, "acme beta\n");
    fs.rmSync(sb.xhome, { recursive: true });
    assert.equal(sb.run(["__names"]).stdout, "");
    assert.equal(fs.existsSync(sb.xhome), false);
    assert.equal(sb.run(["__complete", "bash", "1", "xclaude", ""]).status, 0);
    assert.equal(fs.existsSync(sb.xhome), false, "completion never creates ~/.xclaude");
  });

  it("prints the completion scripts", (t) => {
    const bash = sb.run(["shell", "completion", "bash"]);
    assert.match(bash.stdout, /complete -o nospace -F _xclaude_complete xclaude/);
    assert.doesNotMatch(bash.stdout, /claude\(\)/, "completion only");
    const file = path.join(sb.root, "c.bash");
    fs.writeFileSync(file, bash.stdout);
    assert.equal(sb.spawn("/bin/bash", ["-n", file]).status, 0);
    assert.match(sb.run(["shell", "completion", "zsh"]).stdout, /compdef _xclaude_complete xclaude/);
    assert.equal(sb.run(["shell", "completion", "fish"]).status, 2);
    if (!fs.existsSync(path.join(sb.bin, "zsh"))) t.diagnostic(missingTool("zsh"));
  });
});
