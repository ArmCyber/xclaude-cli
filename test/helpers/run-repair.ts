// Runs one repair in its own process, for concurrency tests:
//   node --experimental-strip-types run-repair.ts <home> <account> [switches]
import { defaultConfig } from "../../src/core/config.ts";
import { resolvePaths } from "../../src/core/paths.ts";
import { repairAccount } from "../../src/link/repair.ts";
import { shareTable } from "../../src/link/table.ts";
import { loadSwitches } from "../../src/switches.ts";

const [home = "", account = "", switches = ""] = process.argv.slice(2);
const paths = resolvePaths({ HOME: home });
const result = repairAccount({
  paths,
  account,
  table: shareTable(defaultConfig(), loadSwitches({ XCLAUDE_SWITCHES: switches })),
  lockWaitMs: Infinity,
  replaceWrongLinks: false,
  log: (line) => process.stderr.write(`${line}\n`),
});
process.stdout.write(JSON.stringify(result));
