import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../../src/core/config.ts";
import { APPENDIX_A, isIgnored, isKnown, NEVER_SHARED, SHARED_DIRS, shareTable } from "../../src/link/table.ts";
import { loadSwitches, SWITCHES } from "../../src/switches.ts";

describe("share table", () => {
  it("shares the built-in entries by default", () => {
    const t = shareTable(defaultConfig(), SWITCHES);
    assert.deepEqual(t.dirs, [...SHARED_DIRS]);
    assert.equal(t.history, true);
    assert.equal(t.stub, true);
    assert.deepEqual(t.refused, []);
    assert.ok(!t.dirs.includes("ide"));
  });

  it("never shares identity, settings, jobs or daemon (invariant 4)", () => {
    for (const e of [".credentials.json", ".claude.json", "settings.json", "jobs", "daemon"]) {
      assert.ok(NEVER_SHARED.includes(e), e);
      assert.ok(!SHARED_DIRS.includes(e), e);
    }
    const c = defaultConfig();
    c.share.add = ["jobs", ".credentials.json", "settings.json", "history.jsonl", "extra"];
    const t = shareTable(c, SWITCHES);
    assert.deepEqual(t.refused, ["jobs", ".credentials.json", "settings.json", "history.jsonl"]);
    assert.ok(t.dirs.includes("extra"));
    assert.ok(!t.dirs.includes("jobs"));
  });

  it("applies share.remove to directories, history and the stub", () => {
    const c = defaultConfig();
    c.share.remove = ["skills", "history.jsonl", "CLAUDE.md"];
    const t = shareTable(c, SWITCHES);
    assert.ok(!t.dirs.includes("skills"));
    assert.equal(t.history, false);
    assert.equal(t.stub, false);
  });

  it("lets share.remove win over share.add", () => {
    const c = defaultConfig();
    c.share.add = ["extra"];
    c.share.remove = ["extra"];
    assert.ok(!shareTable(c, SWITCHES).dirs.includes("extra"));
  });

  it("follows the spike switches", () => {
    const s = loadSwitches({ XCLAUDE_SWITCHES: "shareSessions=0,shareSkills=0,shareChrome=0,shareHistory=0,linkIde=1" });
    const t = shareTable(defaultConfig(), s);
    for (const e of ["sessions", "skills", "chrome"]) assert.ok(!t.dirs.includes(e), e);
    assert.ok(t.dirs.includes("ide"));
    assert.equal(t.history, false);
  });

  it("parses XCLAUDE_SWITCHES leniently", () => {
    assert.deepEqual(loadSwitches({}), SWITCHES);
    const s = loadSwitches({ XCLAUDE_SWITCHES: " spawnFallback , normalizePaths=true,bogus=1,keepSameEmailLogin=0" });
    assert.equal(s.spawnFallback, true);
    assert.equal(s.normalizePaths, true);
    assert.equal(s.keepSameEmailLogin, false);
    assert.equal("bogus" in s, false);
  });

  it("ignores locks, leftovers, temp files and Finder metadata", () => {
    for (const n of [".claude.json.lock", ".oauth_refresh.lock", "history.jsonl.lock", ".xclaude-merge-skills-x", ".DS_Store", ".claude.json.tmp.1234.5678", "settings.json.tmp.ab12", "x.tmp-99", "foo.tmp"]) {
      assert.ok(isIgnored(n), n);
    }
    for (const n of ["projects", "tmp", "template", "lockdown", ".tmpfoo"]) assert.ok(!isIgnored(n), n);
  });

  it("knows shared, per-account and Appendix A entries", () => {
    const t = shareTable(defaultConfig(), SWITCHES);
    for (const n of [...APPENDIX_A, "CLAUDE.md", "keybindings.json", "daemon.log", "daemon.log.1", "policy-limits.json.stamp.json", "agents"]) {
      assert.ok(isKnown(n, t), n);
    }
    for (const n of ["foo", "settings.json.bak", "newthing"]) assert.ok(!isKnown(n, t), n);
  });
});
