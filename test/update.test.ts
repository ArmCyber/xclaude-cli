// The update check: version comparison, the registry fetch (against a local
// server, never npm), the recorded answer, the note on open, and the background
// process started through the built CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { main } from "../src/main.ts";
import { CHECK_INTERVAL_MS, checkDue, fetchLatest, isNewer, readUpdateCheck, runUpdateCheck, updateCheckOnOpen } from "../src/update.ts";
import { VERSION } from "../src/version.ts";
import { testCtx, type TestCtx } from "./helpers/ctx.ts";
import { distCli } from "./helpers/sandbox.ts";

/** What the fake registry answers; null means it never answers. */
let reply: { status: number; body: string } | null;
let requests: string[];
let server: http.Server;
let url: string;

before(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (!reply) return;
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/xclaude-cli/latest`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

let ctx: TestCtx;
beforeEach(() => {
  reply = { status: 200, body: JSON.stringify({ name: "xclaude-cli", version: "99.0.0" }) };
  requests = [];
  ctx = testCtx({ env: { XCLAUDE_UPDATE_URL: url } });
});
afterEach(() => ctx.cleanup());

const checkFile = () => path.join(ctx.paths.cache, "update-check.json");
const record = (checkedAt: number, latest: string) => {
  fs.mkdirSync(ctx.paths.cache, { recursive: true });
  fs.writeFileSync(checkFile(), JSON.stringify({ checkedAt, latest }));
};

async function waitFor<T>(get: () => T | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > end) throw new Error(`nothing after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("isNewer", () => {
  it("compares x.y.z numerically", () => {
    for (const [a, b] of [["0.1.3", "0.1.2"], ["0.2.0", "0.1.9"], ["1.0.0", "0.99.99"], ["0.1.10", "0.1.9"]]) assert.equal(isNewer(a!, b!), true, `${a} > ${b}`);
    for (const [a, b] of [["0.1.2", "0.1.2"], ["0.1.1", "0.1.2"], ["0.9.9", "1.0.0"]]) assert.equal(isNewer(a!, b!), false, `${a} <= ${b}`);
  });

  it("puts a prerelease before its release, and never calls garbage newer", () => {
    assert.equal(isNewer("0.1.3", "0.1.3-beta.1"), true);
    assert.equal(isNewer("0.1.3-beta.1", "0.1.2"), true);
    assert.equal(isNewer("0.1.3-beta.1", "0.1.3"), false);
    assert.equal(isNewer("latest", "0.1.2"), false);
    assert.equal(isNewer("0.1.3", "dev"), false);
  });
});

describe("checkDue", () => {
  it("is due without a check, a day after one, or when the clock went back", () => {
    const now = Date.now();
    assert.equal(checkDue(null, now), true);
    assert.equal(checkDue({ checkedAt: now - 60 * 60 * 1000, latest: "1.0.0" }, now), false);
    assert.equal(checkDue({ checkedAt: now - CHECK_INTERVAL_MS, latest: "1.0.0" }, now), true);
    assert.equal(checkDue({ checkedAt: now + 60_000, latest: "1.0.0" }, now), true);
  });
});

describe("the registry fetch", () => {
  it("returns the latest version", async () => {
    assert.equal(await fetchLatest(url), "99.0.0");
    assert.deepEqual(requests, ["/xclaude-cli/latest"]);
  });

  it("returns null for an error status, a bad body or no version", async () => {
    for (const r of [{ status: 503, body: "{}" }, { status: 404, body: '{"version":"1.0.0"}' }, { status: 200, body: "<html>" }, { status: 200, body: "{}" }, { status: 200, body: '{"version":"soon"}' }]) {
      reply = r;
      assert.equal(await fetchLatest(url), null, JSON.stringify(r));
    }
  });

  it("returns null when nothing listens or nothing answers", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    assert.equal(await fetchLatest(`http://127.0.0.1:${port}/`), null);
    reply = null;
    assert.equal(await fetchLatest(url, 200), null);
  });
});

describe("the recorded answer", () => {
  it("is written with the time of the check, mode 0600", async () => {
    await runUpdateCheck(ctx.paths, url, () => 1234);
    assert.deepEqual(readUpdateCheck(ctx.paths), { checkedAt: 1234, latest: "99.0.0" });
    assert.equal(fs.statSync(checkFile()).mode & 0o777, 0o600);
  });

  it("is left alone when the check fails, so the next open tries again", async () => {
    record(1000, "1.2.3");
    const before = fs.readFileSync(checkFile(), "utf8");
    reply = { status: 503, body: "" };
    await runUpdateCheck(ctx.paths, url);
    assert.equal(fs.readFileSync(checkFile(), "utf8"), before);
  });

  it("reads a corrupt or odd file as no check", () => {
    assert.equal(readUpdateCheck(ctx.paths), null);
    fs.mkdirSync(ctx.paths.cache, { recursive: true });
    for (const text of ["{", "null", "[]", '{"checkedAt":"x","latest":"1.0.0"}', '{"checkedAt":1}']) {
      fs.writeFileSync(checkFile(), text);
      assert.equal(readUpdateCheck(ctx.paths), null, text);
    }
  });
});

describe("on open", () => {
  beforeEach(() => {
    ctx.setConfig(() => {});
    ctx.tty.stderr = true;
  });

  it("notes a newer version on every command that someone sees", async () => {
    record(Date.now(), "99.0.0");
    assert.equal(await main(["ls"], ctx), 0);
    assert.match(ctx.io.stderr, new RegExp(`^xclaude: an update is available \\(${VERSION.replace(/\./g, "\\.")} → 99\\.0\\.0\\); please run npm install -g xclaude-cli to update\n`));
  });

  it("says nothing for the same or an older version, off a terminal, or when turned off", async () => {
    record(Date.now(), VERSION);
    await main(["ls"], ctx);
    record(Date.now(), "0.0.1");
    await main(["ls"], ctx);
    record(Date.now(), "99.0.0");
    ctx.tty.stderr = false;
    await main(["ls"], ctx);
    const off = testCtx({ env: { XCLAUDE_NO_UPDATE_CHECK: "1" } });
    try {
      off.tty.stderr = true;
      off.setConfig(() => {});
      fs.mkdirSync(off.paths.cache, { recursive: true });
      fs.writeFileSync(path.join(off.paths.cache, "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latest: "99.0.0" }));
      await main(["ls"], off);
      assert.doesNotMatch(off.io.stderr, /update/);
    } finally {
      off.cleanup();
    }
    assert.doesNotMatch(ctx.io.stderr, /update/);
  });

  it("starts a background check when one is due, which records the answer", async () => {
    if (!fs.existsSync(distCli)) throw new Error(`${distCli} is missing: run npm run build first`);
    ctx.selfPath = distCli;
    const started = performance.now();
    updateCheckOnOpen(ctx, VERSION);
    assert.ok(performance.now() - started < 1000, "returns without waiting for the check");
    assert.equal(ctx.io.stderr, "");
    const check = await waitFor(() => readUpdateCheck(ctx.paths));
    assert.equal(check.latest, "99.0.0");
    assert.deepEqual(requests, ["/xclaude-cli/latest"]);
    // Within the day, the recorded answer is used and nobody asks again.
    updateCheckOnOpen(ctx, VERSION);
    assert.match(ctx.io.stderr, /an update is available/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(requests.length, 1);
  });
});
