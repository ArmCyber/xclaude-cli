// The README and `xclaude help` describe the same commands.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { helpText } from "../src/commands/help.ts";
import { COMMANDS } from "../src/core/config.ts";

const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("docs", () => {
  it("every command in the README table is in xclaude help, with the same synopsis", () => {
    const rows = [...readme.matchAll(/^\| `xclaude ([^`]+)` \|/gm)].map((m) => m[1]!.replace(/\\\|/g, "|"));
    assert.ok(rows.length >= 10, "the README table was found");
    const help = helpText().replace(/\s+/g, " ");
    for (const row of rows) {
      if (row.startsWith("<account>") || row.startsWith("[claude")) continue; // the launch forms
      const synopsis = row.replace(/\s+/g, " ");
      const [cmd] = synopsis.split(" ");
      assert.ok(help.includes(` ${cmd} `), `help mentions ${cmd}`);
      // Everything up to the first option, e.g. "rm <name>", "tmux new|attach|ls|kill".
      const head = synopsis.split(" [")[0]!;
      assert.ok(help.includes(head), `help has "${head}"`);
    }
  });

  it("every help screen fits in 80 columns", () => {
    for (const topic of [undefined, ...COMMANDS]) {
      for (const line of helpText(topic).split("\n")) assert.ok(line.length <= 80, `${topic ?? "main"}: ${line}`);
    }
  });

  it("every command has its own help", () => {
    for (const c of COMMANDS) assert.match(helpText(c), /^Usage: xclaude /, c);
  });

  it("the README mentions every command", () => {
    for (const c of COMMANDS.filter((c) => c !== "help")) assert.ok(readme.includes(`xclaude ${c}`), c);
  });
});
