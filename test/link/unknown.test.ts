// Unknown entries.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { emptyState } from "../../src/core/state.ts";
import { storeUnknownEntries, takeNewUnknown, unknownEntries, unknownNotice } from "../../src/link/unknown.ts";
import { type Home, makeHome } from "../helpers/accounts.ts";

let h: Home;
beforeEach(() => {
  h = makeHome();
});
afterEach(() => h.cleanup());

describe("unknown entries", () => {
  it("lists only entries nobody knows", () => {
    const A = h.account("acme");
    for (const n of ["foo", "bar", "statsig", ".claude.json", "settings.json", "daemon.log.2", ".oauth_refresh.lock", ".xclaude-link-x", ".DS_Store"]) {
      fs.writeFileSync(path.join(A, n), "");
    }
    const res = h.repair("acme");
    assert.deepEqual(unknownEntries(res.names, h.table()), ["bar", "foo"]);
  });

  it("reports each entry once per account", () => {
    const state = emptyState();
    assert.deepEqual(takeNewUnknown(state, "acme", ["foo"]), ["foo"]);
    assert.deepEqual(takeNewUnknown(state, "acme", ["bar", "foo"]), ["bar"]);
    assert.deepEqual(takeNewUnknown(state, "acme", ["bar", "foo"]), []);
    assert.deepEqual(takeNewUnknown(state, "other", ["foo"]), ["foo"]);
    assert.deepEqual(state.seenUnknownEntries, { acme: ["bar", "foo"], other: ["foo"] });
  });

  it("words the notice exactly", () => {
    assert.equal(
      unknownNotice("acme", "foo", "~/.xclaude/config.json"),
      'xclaude: new Claude Code entry "foo" in acme stays per-account; to share it, add "foo" to share.add in ~/.xclaude/config.json',
    );
  });

  it("lists unknown store entries, ignoring the main identity's own files", () => {
    assert.deepEqual(storeUnknownEntries(h.S, h.table()), []);
    fs.mkdirSync(h.S, { recursive: true });
    for (const n of ["settings.json", ".credentials.json", "projects", "CLAUDE.md", "history.jsonl", "mystery", "history.jsonl.lock"]) {
      fs.writeFileSync(path.join(h.S, n), "");
    }
    assert.deepEqual(storeUnknownEntries(h.S, h.table()), ["mystery"]);
  });
});
