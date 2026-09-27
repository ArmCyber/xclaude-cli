// History merge.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DirLock, HISTORY_LOCK } from "../../src/core/lock.ts";
import { mergeHistoryLines, timestampOf } from "../../src/link/history.ts";
import { asideName } from "../../src/link/merge.ts";
import { type Home, linkTarget, makeHome } from "../helpers/accounts.ts";

let h: Home;
let A: string;
beforeEach(() => {
  h = makeHome();
  A = h.account("acme");
});
afterEach(() => h.cleanup());

const entry = (display: string, timestamp?: number | string) => JSON.stringify({ display, pastedContents: {}, timestamp, project: "/p" });
const lines = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("mergeHistoryLines", () => {
  it("reads numeric and ISO timestamps", () => {
    assert.equal(timestampOf(entry("a", 5)), 5);
    assert.equal(timestampOf(entry("a", "1970-01-01T00:00:01.000Z")), 1000);
    assert.equal(timestampOf(entry("a")), null);
    assert.equal(timestampOf("not json"), null);
  });

  it("drops exact duplicates and orders by timestamp", () => {
    const store = [entry("s1", 10), entry("s3", 30), entry("dup", 25)];
    const account = [entry("a2", 20), entry("dup", 25), entry("a4", 40), ""];
    assert.deepEqual(mergeHistoryLines(store, account), [entry("s1", 10), entry("a2", 20), entry("dup", 25), entry("s3", 30), entry("a4", 40)]);
  });

  it("keeps entries without a timestamp after the entry before them", () => {
    const store = [entry("s1", 10), entry("s2", 30)];
    const account = [entry("a1", 20), "legacy line", entry("a2", 40)];
    assert.deepEqual(mergeHistoryLines(store, account), [entry("s1", 10), entry("a1", 20), "legacy line", entry("s2", 30), entry("a2", 40)]);
    assert.deepEqual(mergeHistoryLines(["first", entry("s", 5)], []), ["first", entry("s", 5)]);
  });
});

describe("history merge", () => {
  it("swaps in the link and merges both histories", () => {
    fs.mkdirSync(h.S, { recursive: true });
    fs.writeFileSync(path.join(h.S, "history.jsonl"), `${entry("s1", 10)}\n${entry("same", 15)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(A, "history.jsonl"), `${entry("a1", 12)}\n${entry("same", 15)}\n${entry("a2", 20)}`);
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.equal(linkTarget(path.join(A, "history.jsonl")), path.join(h.S, "history.jsonl"));
    assert.deepEqual(lines(path.join(h.S, "history.jsonl")), [entry("s1", 10), entry("a1", 12), entry("same", 15), entry("a2", 20)]);
    assert.equal(fs.statSync(path.join(h.S, "history.jsonl")).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-") || n.endsWith(".lock")), []);
    assert.ok(!fs.existsSync(path.join(h.S, "history.jsonl.lock")));
    assert.match(h.logs.join("\n"), /merged acme's prompt history into ~\/\.claude\/history\.jsonl: 2 entries added/);
  });

  it("creates the store's history when it has none", () => {
    fs.writeFileSync(path.join(A, "history.jsonl"), `${entry("a1", 1)}\n`);
    h.repair("acme");
    assert.deepEqual(lines(path.join(h.S, "history.jsonl")), [entry("a1", 1)]);
  });

  it("locks a symlinked store history at its real path", () => {
    const dot = path.join(h.root, "dotfiles");
    fs.mkdirSync(dot);
    fs.writeFileSync(path.join(dot, "history.jsonl"), `${entry("s", 1)}\n`);
    fs.mkdirSync(h.S, { recursive: true });
    fs.symlinkSync(path.join(dot, "history.jsonl"), path.join(h.S, "history.jsonl"));
    fs.writeFileSync(path.join(A, "history.jsonl"), `${entry("a", 2)}\n`);
    // Hold the lock at the real path: the merge must wait for it, then give up.
    const held = DirLock.acquire(path.join(dot, "history.jsonl.lock"), HISTORY_LOCK, { waitMs: 0 })!;
    const res = h.repair("acme", { lockWaitMs: 200 });
    held.release();
    assert.match(res.problems.find((p) => p.entry === "history.jsonl")!.message, /not merged yet \(the shared history\.jsonl is busy\)/);
    // The swap already happened; the aside holds the account's lines until the next repair.
    assert.equal(linkTarget(path.join(A, "history.jsonl")), path.join(dot, "history.jsonl"));
    assert.equal(h.repair("acme").clean, true);
    assert.deepEqual(lines(path.join(dot, "history.jsonl")), [entry("s", 1), entry("a", 2)]);
    assert.ok(fs.lstatSync(path.join(h.S, "history.jsonl")).isSymbolicLink(), "the store's own link is kept");
  });

  it("waits for the account's lock and gives up at launch", () => {
    fs.writeFileSync(path.join(A, "history.jsonl"), `${entry("a", 1)}\n`);
    const held = DirLock.acquire(path.join(A, "history.jsonl.lock"), HISTORY_LOCK, { waitMs: 0 })!;
    const started = Date.now();
    const res = h.repair("acme", { lockWaitMs: 200 });
    held.release();
    assert.ok(Date.now() - started < 5_000);
    assert.match(res.problems.find((p) => p.entry === "history.jsonl")!.message, /this account's history\.jsonl is busy/);
    assert.ok(fs.lstatSync(path.join(A, "history.jsonl")).isFile(), "nothing changed");
    assert.equal(h.repair("acme").clean, true);
  });

  it("resumes an aside left after the swap", () => {
    h.repair("acme");
    fs.writeFileSync(path.join(h.S, "history.jsonl"), `${entry("s", 2)}\n`);
    fs.writeFileSync(path.join(A, asideName("history.jsonl")), `${entry("old", 1)}\n${entry("s", 2)}\n`);
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.deepEqual(lines(path.join(h.S, "history.jsonl")), [entry("old", 1), entry("s", 2)]);
    assert.deepEqual(fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-")), []);
  });

  it("drops an aside left before the swap, then merges normally", () => {
    fs.writeFileSync(path.join(A, "history.jsonl"), `${entry("a", 1)}\n`);
    fs.linkSync(path.join(A, "history.jsonl"), path.join(A, asideName("history.jsonl")));
    const res = h.repair("acme");
    assert.deepEqual(res.problems, []);
    assert.deepEqual(lines(path.join(h.S, "history.jsonl")), [entry("a", 1)]);
    assert.deepEqual(fs.readdirSync(A).filter((n) => n.startsWith(".xclaude-")), []);
  });
});

describe("history merge under a concurrent writer", () => {
  const writer = fileURLToPath(new URL("../helpers/history-writer.mjs", import.meta.url));

  for (const retries of [0, 3]) {
    it(`loses no reported line (${retries ? "with" : "without"} retries)`, async (t) => {
      const count = 300;
      const before = Array.from({ length: 200 }, (_, i) => entry(`old-${i}`, 1000 + i));
      fs.writeFileSync(path.join(A, "history.jsonl"), `${before.join("\n")}\n`);
      fs.mkdirSync(h.S, { recursive: true });
      fs.writeFileSync(path.join(h.S, "history.jsonl"), `${entry("store", 500)}\n`);

      const child = spawn(process.execPath, [writer, path.join(A, "history.jsonl"), String(count), String(retries), "w"], { env: {} });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const done = new Promise<number | null>((resolve) => child.on("close", resolve));

      // Merge once the writer is well into its appends.
      const deadline = Date.now() + 10_000;
      while (lines(path.join(A, "history.jsonl")).length < before.length + 30 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const res = h.repair("acme");
      assert.deepEqual(res.problems, []);
      assert.equal(await done, 0);

      const { written, failed } = JSON.parse(out) as { written: number[]; failed: number };
      t.diagnostic(`writer: ${written.length} appended, ${failed} refused while the merge held the lock`);
      const final = lines(path.join(h.S, "history.jsonl"));
      const displays = final.map((l) => JSON.parse(l).display as string);
      for (const i of written) {
        assert.equal(displays.filter((d) => d === `w-${i}`).length, 1, `line w-${i} appears exactly once`);
      }
      for (let i = 0; i < before.length; i++) assert.equal(displays.filter((d) => d === `old-${i}`).length, 1);
      assert.equal(displays.filter((d) => d === "store").length, 1);
      assert.equal(final.length, written.length + before.length + 1, "nothing else sneaked in");
      assert.equal(linkTarget(path.join(A, "history.jsonl")), path.join(h.S, "history.jsonl"));
      if (retries) assert.equal(written.length, count, "with retries every append succeeds");
    });
  }
});
