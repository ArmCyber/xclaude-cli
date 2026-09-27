// CLAUDE.md stub.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { inspectAccount } from "../../src/link/repair.ts";
import { STUB_TEXT } from "../../src/link/stub.ts";
import { type Home, makeHome } from "../helpers/accounts.ts";

let h: Home;
let A: string;
beforeEach(() => {
  h = makeHome();
  A = h.account("acme");
  fs.mkdirSync(h.S, { recursive: true });
});
afterEach(() => h.cleanup());

const stubOf = (detail = true) => inspectAccount(h.paths, "acme", h.table(), detail).stub;

describe("CLAUDE.md stub", () => {
  it("has the exact stub text", () => {
    assert.equal(STUB_TEXT, "Shared instructions live in ~/.claude/CLAUDE.md, so edit that file.\n@~/.claude/CLAUDE.md\n");
  });

  it("is created while ~/.claude/CLAUDE.md exists", () => {
    h.repair("acme");
    assert.equal(fs.existsSync(path.join(A, "CLAUDE.md")), false, "no stub without a shared CLAUDE.md");
    fs.writeFileSync(path.join(h.S, "CLAUDE.md"), "# shared\n");
    assert.equal(h.repair("acme").clean, true);
    assert.equal(fs.readFileSync(path.join(A, "CLAUDE.md"), "utf8"), STUB_TEXT);
    assert.equal(fs.statSync(path.join(A, "CLAUDE.md")).mode & 0o777, 0o600);
    assert.equal(stubOf(), "ok");
  });

  it("follows a symlinked ~/.claude/CLAUDE.md", () => {
    fs.writeFileSync(path.join(h.root, "dotfiles-CLAUDE.md"), "# shared\n");
    fs.symlinkSync(path.join(h.root, "dotfiles-CLAUDE.md"), path.join(h.S, "CLAUDE.md"));
    h.repair("acme");
    assert.equal(fs.readFileSync(path.join(A, "CLAUDE.md"), "utf8"), STUB_TEXT);
  });

  it("is removed once ~/.claude/CLAUDE.md is gone", () => {
    fs.writeFileSync(path.join(h.S, "CLAUDE.md"), "# shared\n");
    h.repair("acme");
    fs.rmSync(path.join(h.S, "CLAUDE.md"));
    assert.equal(stubOf(false), "remove");
    h.repair("acme");
    assert.equal(fs.existsSync(path.join(A, "CLAUDE.md")), false);
  });

  it("never touches an account file that differs from the stub", () => {
    fs.writeFileSync(path.join(A, "CLAUDE.md"), "my own rules\n");
    fs.writeFileSync(path.join(h.S, "CLAUDE.md"), "# shared\n");
    h.repair("acme");
    assert.equal(fs.readFileSync(path.join(A, "CLAUDE.md"), "utf8"), "my own rules\n");
    assert.equal(stubOf(), "differs");
    assert.equal(stubOf(false), "ok", "launches don't read it");
    fs.rmSync(path.join(h.S, "CLAUDE.md"));
    h.repair("acme");
    assert.equal(fs.readFileSync(path.join(A, "CLAUDE.md"), "utf8"), "my own rules\n");
    assert.equal(stubOf(), "differs");
  });

  it("is removed when share.remove lists CLAUDE.md", () => {
    fs.writeFileSync(path.join(h.S, "CLAUDE.md"), "# shared\n");
    h.repair("acme");
    h.config.share.remove = ["CLAUDE.md"];
    h.repair("acme");
    assert.equal(fs.existsSync(path.join(A, "CLAUDE.md")), false);
  });
});
