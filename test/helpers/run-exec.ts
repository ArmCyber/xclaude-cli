// Runs makeExec in its own process: node --experimental-strip-types run-exec.ts <spawn|execve> <file> [args…]
import { makeExec } from "../../src/launch/exec.ts";

const [mode, file = "", ...args] = process.argv.slice(2);
const exec = makeExec({ spawnFallback: mode === "spawn" });
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
process.exitCode = await exec(file, [file, ...args], env);
