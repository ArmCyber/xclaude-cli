import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { accountDir, ensureXHome, mkdirPrivate, realpathOrNull, resolvePaths, tildify } from "../../src/core/paths.ts";

describe("paths", () => {
  it("defaults to ~/.xclaude and ~/.claude", () => {
    const p = resolvePaths({ HOME: "/home/u" });
    assert.equal(p.xhome, "/home/u/.xclaude");
    assert.equal(p.store, "/home/u/.claude");
    assert.equal(p.config, "/home/u/.xclaude/config.json");
    assert.equal(p.state, "/home/u/.xclaude/state.json");
    assert.equal(p.accounts, "/home/u/.xclaude/accounts");
  });

  it("honors XCLAUDE_HOME, made absolute without a trailing slash", () => {
    assert.equal(resolvePaths({ HOME: "/home/u", XCLAUDE_HOME: "/data/xc/" }).xhome, "/data/xc");
    const rel = resolvePaths({ HOME: "/home/u", XCLAUDE_HOME: "rel/xc" }).xhome;
    assert.equal(rel, path.resolve("rel/xc"));
  });

  it("builds the account dir as the literal path.join string", () => {
    const p = resolvePaths({ HOME: "/home/u", XCLAUDE_HOME: "/data/xc//" });
    assert.equal(accountDir(p, "acme"), "/data/xc/accounts/acme");
  });

  it("never resolves links in the account dir string", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xclaude-paths-")));
    try {
      fs.mkdirSync(path.join(root, "real"));
      fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
      const p = resolvePaths({ HOME: root, XCLAUDE_HOME: path.join(root, "link") });
      assert.equal(accountDir(p, "acme"), path.join(root, "link", "accounts", "acme"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates private directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xclaude-paths-"));
    try {
      const p = resolvePaths({ HOME: root });
      ensureXHome(p);
      assert.equal(fs.statSync(p.xhome).mode & 0o777, 0o700);
      mkdirPrivate(accountDir(p, "acme"));
      assert.equal(fs.statSync(accountDir(p, "acme")).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("realpathOrNull returns null for dangling links", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xclaude-paths-")));
    try {
      fs.symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling"));
      assert.equal(realpathOrNull(path.join(root, "dangling")), null);
      assert.equal(realpathOrNull(root), root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tildify shortens paths under home only", () => {
    assert.equal(tildify("/home/u/code/api", "/home/u"), "~/code/api");
    assert.equal(tildify("/home/u", "/home/u"), "~");
    assert.equal(tildify("/home/user2/x", "/home/u"), "/home/user2/x");
  });
});
