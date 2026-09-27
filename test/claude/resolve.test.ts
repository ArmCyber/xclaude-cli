import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { findClaude } from "../../src/claude/resolve.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { removeTemp, tempDir } from "../helpers/tmp.ts";

let root: string;
beforeEach(() => {
  root = tempDir();
});
afterEach(() => removeTemp(root));

function exe(rel: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
  return p;
}

describe("findClaude", () => {
  it("prefers XCLAUDE_CLAUDE_PATH, then claudePath", () => {
    const a = exe("a/claude");
    const b = exe("b/claude");
    const onPath = exe("bin/claude");
    const config = defaultConfig();
    config.claudePath = b;
    const home = path.join(root, "home");
    assert.equal(findClaude({ XCLAUDE_CLAUDE_PATH: a, PATH: path.dirname(onPath) }, config, home, null), a);
    assert.equal(findClaude({ PATH: path.dirname(onPath) }, config, home, null), b);
    assert.equal(findClaude({ PATH: path.dirname(onPath) }, defaultConfig(), home, null), onPath);
  });

  it("rejects an explicit setting that doesn't work", () => {
    assert.throws(() => findClaude({ XCLAUDE_CLAUDE_PATH: path.join(root, "nope") }, defaultConfig(), root, null), /XCLAUDE_CLAUDE_PATH is set to .*nope, which isn't an executable file/);
    const config = defaultConfig();
    config.claudePath = root; // a directory
    assert.throws(() => findClaude({}, config, root, null), /claudePath in ~\/\.xclaude\/config\.json/);
  });

  it("skips non-executables and a claude that is xclaude itself", () => {
    const self = exe("pkg/dist/xclaude.js");
    fs.mkdirSync(path.join(root, "shim"));
    fs.symlinkSync(self, path.join(root, "shim", "claude"));
    fs.mkdirSync(path.join(root, "noexec"));
    fs.writeFileSync(path.join(root, "noexec", "claude"), "", { mode: 0o644 });
    const real = exe("real/claude");
    const PATH = ["relative/dir", path.join(root, "shim"), path.join(root, "noexec"), path.dirname(real)].join(":");
    assert.equal(findClaude({ PATH }, defaultConfig(), root, self), real);
  });

  it("falls back to ~/.local/bin/claude", () => {
    const home = path.join(root, "home");
    const local = exe("home/.local/bin/claude");
    assert.equal(findClaude({ PATH: path.join(root, "empty") }, defaultConfig(), home, null), local);
  });

  it("explains how to install when nothing is found", (t) => {
    // The system-wide fallbacks may exist on a developer machine.
    if (["/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"].some((p) => fs.existsSync(p))) {
      t.skip("a system-wide claude exists here");
      return;
    }
    assert.throws(() => findClaude({ PATH: "" }, defaultConfig(), path.join(root, "home"), null), /isn't installed .*install\.sh/);
  });
});
