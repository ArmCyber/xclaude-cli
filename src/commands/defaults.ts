// The --model, --effort and --args options shared by `add` and `set`.
import { type Defaults, EFFORTS, isEffort } from "../core/config.ts";
import { UsageError } from "../core/errors.ts";
import { type Parsed, stringOption } from "../core/options.ts";
import { quoteShellWords, splitShellWords } from "../core/shellwords.ts";
import { DASH } from "../core/format.ts";

export const DEFAULT_OPTIONS = { model: { value: true }, effort: { value: true }, args: { value: true } } as const;

/** Applies --model, --effort and --args to `into`. */
export function applyDefaultOptions(p: Parsed, home: string, into: Defaults): void {
  const model = stringOption(p, "model");
  if (model !== undefined) {
    if (!model.trim()) throw new UsageError("--model needs a model name, e.g. opus");
    into.model = model;
  }
  const effort = stringOption(p, "effort");
  if (effort !== undefined) {
    if (!isEffort(effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}`);
    into.effort = effort;
  }
  const args = stringOption(p, "args");
  if (args !== undefined) into.args = splitShellWords(args, home);
}

/** Two-column listing of an identity's defaults. */
export function formatDefaults(d: Defaults): string {
  return [
    `  model   ${d.model ?? DASH}`,
    `  effort  ${d.effort ?? DASH}`,
    `  args    ${d.args.length ? quoteShellWords(d.args) : DASH}`,
  ]
    .map((l) => `${l}\n`)
    .join("");
}
