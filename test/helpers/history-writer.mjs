// Emulates Claude Code's prompt-history writer: each append takes a
// proper-lockfile lock (stale 10 s) on the file's resolved path.
//   node history-writer.mjs <history.jsonl> <count> <retries: 0|3> <tag>
// Prints { written: [i…], failed } as JSON: only lines reported as written count.
import fs from "node:fs";
import lockfile from "proper-lockfile";

const [file, countArg, retriesArg, tag] = process.argv.slice(2);
const count = Number(countArg);
const retries = Number(retriesArg);
const written = [];
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < count; i++) {
  const line = `${JSON.stringify({ display: `${tag}-${i}`, pastedContents: {}, timestamp: Date.now(), project: "/p" })}\n`;
  try {
    const release = await lockfile.lock(file, { stale: 10_000, retries });
    try {
      fs.appendFileSync(file, line);
      written.push(i);
    } finally {
      await release();
    }
  } catch {
    failed++;
  }
  await sleep(1);
}

process.stdout.write(JSON.stringify({ written, failed }));
