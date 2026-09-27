import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { escapeArg, isNoServer, Tmux, tmuxEnv } from "../../src/tmux/client.ts";
import { listSessions, sessionName } from "../../src/tmux/sessions.ts";
import { makeSandbox, type Sandbox } from "../helpers/sandbox.ts";
import { needTmux, tmux } from "../helpers/tmux.ts";

describe("tmux client, pure parts", () => {
  it("tells a missing server from a real connection error", () => {
    assert.equal(isNoServer("no server running on /tmp/tmux-1000/default"), true);
    assert.equal(isNoServer("error connecting to /tmp/tmux-1000/default (No such file or directory)"), true);
    assert.equal(isNoServer("error connecting to /very/long/path/default (File name too long)"), false);
    assert.equal(isNoServer("error connecting to /tmp/tmux-1000/default (Permission denied)"), false);
  });

  it("escapes a trailing semicolon only", () => {
    assert.equal(escapeArg("a;"), "a\\;");
    assert.equal(escapeArg("a;b"), "a;b");
    assert.equal(escapeArg(";"), "\\;");
    assert.equal(escapeArg("plain"), "plain");
  });

  it("strips account and Claude-session variables", () => {
    const env = tmuxEnv({
      PATH: "/bin",
      HOME: "/h",
      CLAUDE_CONFIG_DIR: "/x",
      XCLAUDE_ACCOUNT: "acme",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/y",
      CLAUDECODE: "1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/run/sock",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h", CLAUDE_CODE_USE_BEDROCK: "1" }, "user settings like CLAUDE_CODE_USE_BEDROCK stay");
  });

  it("names sessions without collisions", () => {
    assert.equal(sessionName("acme", "api"), "xclaude-acme_api");
    assert.equal(sessionName(null, "api"), "xclaude--api");
    assert.notEqual(sessionName("a", "b-c"), sessionName("a-b", "c"));
  });
});

describe("tmux client, private server", () => {
  let sb: Sandbox;
  beforeEach(() => {
    sb = makeSandbox();
  });
  afterEach(() => sb.cleanup());

  it("treats a missing server as no sessions, and checks names exactly", (t) => {
    if (!needTmux(sb, t)) return;
    const client = new Tmux(sb.env);
    assert.deepEqual(listSessions(client), []);
    const v = client.version();
    assert.ok(v && v[0] >= 3, `tmux version ${v}`);
    tmux(sb, ["new-session", "-d", "-s", "xclaude-acme_api2"]);
    assert.equal(client.hasSession("xclaude-acme_api2"), true);
    assert.equal(client.hasSession("xclaude-acme_api"), false, "no prefix matching");
    assert.deepEqual(listSessions(client), [], "sessions without @xclaude=1 aren't listed");
  });

  it("explains a missing tmux", () => {
    assert.throws(() => new Tmux({ PATH: "/nonexistent" }), /tmux isn't installed/);
  });
});
