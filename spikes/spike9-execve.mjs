// Spike 9, non-interactive part: how process.execve behaves on this Node.
//   node spikes/spike9-execve.mjs          prints a Markdown report, exits 1 if a check fails
// Checks: execve exists; argv[0] must be passed; a failed call aborts the
// process (before Node 26.1) instead of throwing; nothing is printed on success.
import { spawnSync } from "node:child_process";

const node = process.execPath;
const run = (code) => spawnSync(node, ["-e", code], { encoding: "utf8" });
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

check("process.execve exists", typeof process.execve === "function", `typeof process.execve is ${typeof process.execve}`);

// argv[0] is taken as given: /bin/sh -c 'echo "$0|$1"' zero one prints "zero|one".
const withArgv0 = run(`process.execve("/bin/sh", ["/bin/sh", "-c", 'echo "$0|$1"', "zero", "one"], process.env)`);
check("argv[0] is passed through as the first element", withArgv0.stdout.trim() === "zero|one", `stdout ${JSON.stringify(withArgv0.stdout.trim())}`);
const withoutArgv0 = run(`process.execve("/bin/sh", ["-c", 'echo "$0|$1"', "zero", "one"], process.env)`);
check(
  "leaving argv[0] out shifts every argument (so xclaude must include it)",
  withoutArgv0.stdout.trim() !== "zero|one",
  `stdout ${JSON.stringify(withoutArgv0.stdout.trim())}, stderr ${JSON.stringify(withoutArgv0.stderr.trim().split("\n")[0] ?? "")}`,
);

// A failed execve: aborts before Node 26.1, throws after.
const [major, minor] = process.versions.node.split(".").map(Number);
const aborts = major < 26 || (major === 26 && minor < 1);
const failed = run(`try { process.execve("/nonexistent/xclaude-spike9", ["x"], process.env) } catch (e) { console.log("threw " + e.code) }`);
if (aborts) {
  check("a failed call aborts the process (SIGABRT), so it can't be caught", failed.signal === "SIGABRT" || failed.status === 134, `status ${failed.status}, signal ${failed.signal}`);
} else {
  check("a failed call throws (Node 26.1+)", failed.stdout.startsWith("threw"), `stdout ${JSON.stringify(failed.stdout.trim())}`);
}

// No warning on a successful call.
const quiet = run(`process.execve("/bin/sh", ["/bin/sh", "-c", "exit 0"], process.env)`);
check("no warning is printed", quiet.status === 0 && quiet.stderr === "", `status ${quiet.status}, stderr ${JSON.stringify(quiet.stderr.trim())}`);

const ok = results.every((r) => r.pass);
const lines = [
  `### Spike 9 on Node ${process.versions.node} (${process.platform}-${process.arch})`,
  "",
  ...results.map((r) => `- ${r.pass ? "✓" : "✗"} ${r.name}: ${r.detail}`),
  "",
  ok ? "All checks pass." : "Some checks FAILED.",
];
process.stdout.write(`${lines.join("\n")}\n`);
process.exitCode = ok ? 0 : 1;
