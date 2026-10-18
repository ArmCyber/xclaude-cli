// MCP servers from the ~/.claude login, passed to accounts with --mcp-config.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { forgetMcp, mcpFile, mcpServersFor, prepareMcp } from "../../src/link/mcp.ts";
import { type Home, makeHome } from "../helpers/accounts.ts";

let h: Home;
let mainJson: string;
let ownJson: string;
beforeEach(() => {
  h = makeHome();
  ownJson = path.join(h.account("acme"), ".claude.json");
  mainJson = path.join(h.paths.home, ".claude.json");
});
afterEach(() => h.cleanup());

const jira = { type: "http", url: "https://jira.example.com/mcp" };
const git = { type: "stdio", command: "gitlab-mcp", env: { TOKEN: "t" } };

describe("MCP servers from ~/.claude.json", () => {
  it("writes the ~/.claude login's servers to a private file, minus the account's own", () => {
    fs.writeFileSync(mainJson, JSON.stringify({ numStartups: 3, mcpServers: { jira, git } }));
    fs.writeFileSync(ownJson, JSON.stringify({ mcpServers: { git: { type: "stdio", command: "mine" } } }));
    const file = prepareMcp(h.paths, "acme");
    assert.equal(file, mcpFile(h.paths, "acme"));
    assert.deepEqual(JSON.parse(fs.readFileSync(file!, "utf8")), { mcpServers: { jira } });
    assert.equal(fs.statSync(file!).mode & 0o777, 0o600);
    assert.equal(fs.statSync(h.paths.inherit).mode & 0o777, 0o700);

    const mtime = fs.statSync(file!).mtimeMs;
    prepareMcp(h.paths, "acme");
    assert.equal(fs.statSync(file!).mtimeMs, mtime, "unchanged servers aren't written again");
  });

  it("passes nothing when there's nothing to pass, and drops an old file", () => {
    assert.equal(prepareMcp(h.paths, "acme"), null);
    fs.writeFileSync(mainJson, JSON.stringify({ mcpServers: { jira } }));
    assert.ok(prepareMcp(h.paths, "acme"));
    fs.writeFileSync(mainJson, JSON.stringify({ mcpServers: {} }));
    assert.equal(prepareMcp(h.paths, "acme"), null);
    assert.ok(!fs.existsSync(mcpFile(h.paths, "acme")));
  });

  it("keeps the last file while a .claude.json can't be read", () => {
    fs.writeFileSync(mainJson, JSON.stringify({ mcpServers: { jira } }));
    const file = prepareMcp(h.paths, "acme");
    fs.writeFileSync(mainJson, "{half");
    assert.equal(mcpServersFor(h.paths, "acme"), null);
    assert.equal(prepareMcp(h.paths, "acme"), file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file!, "utf8")), { mcpServers: { jira } });
    forgetMcp(h.paths, "acme");
    assert.equal(prepareMcp(h.paths, "acme"), null);
  });
});
