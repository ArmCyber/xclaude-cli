// Entry point. runtime-check.ts must stay the first import: it runs before any
// other module code and rejects old Node versions and unsupported platforms.
import "./runtime-check.ts";
import { Cancelled, EXIT_ERROR, XError } from "./core/errors.ts";
import { stdio } from "./core/io.ts";
import { processCtx } from "./ctx.ts";
import { main } from "./main.ts";

main(process.argv.slice(2), processCtx(stdio)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof Cancelled) {
      process.exitCode = e.exitCode;
    } else if (e instanceof XError) {
      stdio.err(`xclaude: ${e.message}\n`);
      process.exitCode = e.exitCode;
    } else {
      stdio.err(`xclaude: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = EXIT_ERROR;
    }
  },
);
