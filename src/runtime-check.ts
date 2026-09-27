// Imported first by cli.ts, so it runs before any other module code: npm
// doesn't enforce `engines`, so xclaude checks Node and the platform itself.
import fs from "node:fs";
import { runtimeProblem } from "./runtime.ts";

const problem = runtimeProblem(process.platform, process.versions.node);
if (problem) {
  fs.writeSync(2, `xclaude: ${problem}\n`);
  process.exit(1);
}

export {};
