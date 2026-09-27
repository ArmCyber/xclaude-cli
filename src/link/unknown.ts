// Unknown entries: anything in an account dir that isn't in the
// share table, the per-account list or Appendix A stays per account. The first
// time xclaude sees one, it says so once and remembers it in state.json.
import fs from "node:fs";
import { errCode } from "../core/fsutil.ts";
import type { State } from "../core/state.ts";
import { isIgnored, isKnown, type ShareTable } from "./table.ts";

/** Unknown names among an account dir's entries, sorted. */
export function unknownEntries(names: string[], table: ShareTable): string[] {
  return names.filter((n) => !isIgnored(n) && !isKnown(n, table)).sort();
}

/** The unknown entries not seen before, which are then recorded as seen. */
export function takeNewUnknown(state: State, account: string, unknown: string[]): string[] {
  const seen = new Set(state.seenUnknownEntries[account] ?? []);
  const fresh = unknown.filter((n) => !seen.has(n));
  if (fresh.length) state.seenUnknownEntries[account] = [...seen, ...fresh].sort();
  return fresh;
}

export function unknownNotice(account: string, entry: string, configLabel: string): string {
  return `xclaude: new Claude Code entry "${entry}" in ${account} stays per-account; to share it, add "${entry}" to share.add in ${configLabel}`;
}

/**
 * Entries in the store that are in none of the share table, the per-account
 * list or Appendix A (doctor's informational list). The main identity's own
 * files are expected there and aren't listed.
 */
export function storeUnknownEntries(store: string, table: ShareTable): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(store);
  } catch (e) {
    if (errCode(e) === "ENOENT") return [];
    throw e;
  }
  return unknownEntries(names, table);
}
