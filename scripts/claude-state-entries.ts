// Compares the state entries a Claude Code binary keeps in its config dir with
// Appendix A (APPENDIX_A in src/link/table.ts), for the maintenance checklist.
//   node --experimental-strip-types scripts/claude-state-entries.ts [path to claude]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { APPENDIX_A } from "../src/link/table.ts";

const bin = process.argv[2] ?? fs.realpathSync(execFileSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim());
const text = fs.readFileSync(bin, "latin1");
const marker = text.indexOf('"mcp-needs-auth-cache.json"');
if (marker < 0) {
  process.stderr.write(`the entry list wasn't found in ${bin}; look for it by hand\n`);
  process.exit(1);
}
const start = text.lastIndexOf('".claude.json"', marker);
const end = text.indexOf("]", marker);
const inBinary = [...new Set([...text.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]!))];

const added = inBinary.filter((n) => !APPENDIX_A.includes(n));
const removed = APPENDIX_A.filter((n) => !inBinary.includes(n));
process.stdout.write(`${bin}\n${inBinary.length} entries in the binary, ${APPENDIX_A.length} in Appendix A\n`);
process.stdout.write(`new in the binary: ${added.join(", ") || "none"}\n`);
process.stdout.write(`gone from the binary: ${removed.join(", ") || "none"}\n`);
