// CLAUDE.md stub. While ~/.claude/CLAUDE.md exists, each account
// gets a CLAUDE.md that imports it. The ancestor walk only reaches
// ~/.claude/CLAUDE.md from under $HOME, so the stub is what loads the shared
// instructions everywhere else.
import fs from "node:fs";
import path from "node:path";
import { errCode, lstatOrNull, readFileOrNull, statOrNull } from "../core/fsutil.ts";
import { STUB } from "./table.ts";

export const STUB_TEXT = "Shared instructions live in ~/.claude/CLAUDE.md, so edit that file.\n@~/.claude/CLAUDE.md\n";

export type StubState =
  /** The stub is in place (or, without detail, something is). */
  | "ok"
  /** ~/.claude/CLAUDE.md exists and the account has no CLAUDE.md. */
  | "create"
  /** ~/.claude/CLAUDE.md is gone and the account's file is exactly the stub. */
  | "remove"
  /** The account's CLAUDE.md isn't the stub: never touched, doctor reports it. */
  | "differs"
  /** No stub needed and none there. */
  | "none";

/**
 * Where the stub of account dir A stands. Without detail (the launch path),
 * an existing account file is assumed fine while the store has a CLAUDE.md,
 * which saves reading it.
 */
export function stubState(A: string, S: string, enabled: boolean, detail: boolean): StubState {
  const storeHas = enabled && Boolean(statOrNull(path.join(S, STUB))?.isFile());
  const a = lstatOrNull(path.join(A, STUB));
  if (!a) return storeHas ? "create" : "none";
  if (storeHas && !detail) return "ok";
  const isStub = a.isFile() && readFileOrNull(path.join(A, STUB)) === STUB_TEXT;
  if (storeHas) return isStub ? "ok" : "differs";
  return isStub ? "remove" : "differs";
}

/** Creates or removes the stub; anything else is left alone. */
export function applyStub(A: string, state: StubState): "created" | "removed" | null {
  const file = path.join(A, STUB);
  if (state === "create") {
    try {
      fs.writeFileSync(file, STUB_TEXT, { flag: "wx", mode: 0o600 });
      return "created";
    } catch (e) {
      if (errCode(e) === "EEXIST") return null;
      throw e;
    }
  }
  if (state === "remove" && readFileOrNull(file) === STUB_TEXT) {
    fs.unlinkSync(file);
    return "removed";
  }
  return null;
}
