// Fixtures for link-engine tests: a temp home with a store and account dirs.
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, type Config } from "../../src/core/config.ts";
import { accountDir, type Paths, resolvePaths } from "../../src/core/paths.ts";
import { type RepairOptions, type RepairResult, repairAccount } from "../../src/link/repair.ts";
import { type ShareTable, shareTable } from "../../src/link/table.ts";
import { loadSwitches, type Switches } from "../../src/switches.ts";
import { removeTemp, tempDir } from "./tmp.ts";

export interface Home {
  root: string;
  paths: Paths;
  S: string;
  config: Config;
  switches: Switches;
  logs: string[];
  table(): ShareTable;
  /** Creates (if needed) and returns an account dir. */
  account(name: string): string;
  repair(name: string, opts?: Partial<RepairOptions>): RepairResult;
  cleanup(): void;
}

export function makeHome(switchSpec = ""): Home {
  const root = tempDir("xclaude-link-");
  const paths = resolvePaths({ HOME: path.join(root, "home") });
  fs.mkdirSync(paths.home);
  const config = defaultConfig();
  const switches = loadSwitches({ XCLAUDE_SWITCHES: switchSpec });
  const logs: string[] = [];
  const home: Home = {
    root,
    paths,
    S: paths.store,
    config,
    switches,
    logs,
    table: () => shareTable(config, switches),
    account(name) {
      const dir = accountDir(paths, name);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
    repair(name, opts = {}) {
      return repairAccount({
        paths,
        account: name,
        table: home.table(),
        lockWaitMs: Infinity,
        replaceWrongLinks: false,
        log: (line) => logs.push(line),
        ...opts,
      });
    },
    cleanup: () => removeTemp(root),
  };
  return home;
}

/** The target of a link, or null if p isn't a link. */
export function linkTarget(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}
