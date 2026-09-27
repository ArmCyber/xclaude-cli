// Release-candidate smoke test: packs the package, installs the
// tarball into a scratch npm prefix, and runs everything that needs no login in
// a clean environment (temp HOME, private tmux server, the fake claude).
//   node --experimental-strip-types scripts/smoke-rc.ts [--tarball <file>]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xclaude-smoke-")));
const tmuxTmp = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "xcr-"));
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

try {
  // Pack (or take the given tarball) and look inside.
  const given = process.argv[2] === "--tarball" ? path.resolve(process.argv[3] ?? "") : null;
  let tarball = given;
  if (!tarball) {
    execFileSync("npm", ["run", "build"], { cwd: repo, stdio: "ignore" });
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { cwd: repo, encoding: "utf8" })) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    tarball = path.join(root, packed[0]!.filename);
    const files = packed[0]!.files.map((f) => f.path).sort();
    check("tarball holds only the bundle, README, LICENSE and package.json", JSON.stringify(files) === JSON.stringify(["LICENSE", "README.md", "dist/xclaude.js", "package.json"]), files.join(", "));
  }
  const prefix = path.join(root, "prefix");
  execFileSync("npm", ["install", "-g", "--prefix", prefix, "--cache", path.join(root, "npm-cache"), "--no-audit", "--no-fund", tarball], { stdio: "ignore" });
  const bin = path.join(prefix, "bin", "xclaude");
  check("installed bin is a link into the package", fs.lstatSync(bin).isSymbolicLink(), fs.readlinkSync(bin));

  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const tmux = which("tmux");
  const env: Record<string, string> = {
    HOME: home,
    PATH: [path.join(prefix, "bin"), path.dirname(process.execPath), ...(tmux ? [path.dirname(tmux)] : []), "/usr/bin", "/bin"].join(":"),
    TMUX_TMPDIR: tmuxTmp,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SHELL: "/bin/sh",
    TERM: process.env.TERM || "xterm-256color",
    LANG: process.env.LANG || "C.UTF-8",
    XCLAUDE_CLAUDE_PATH: path.join(repo, "test", "fake-claude", "claude.mjs"),
  };
  const x = (args: string[]) => spawnSync(bin, args, { env, cwd: home, encoding: "utf8" });

  const v = x(["--version"]);
  check("--version", v.status === 0 && v.stdout.trim() === pkg.version, v.stdout.trim());
  const h = x(["help"]);
  check("help", h.status === 0 && h.stdout.startsWith("xclaude — "), h.stdout.split("\n")[0] ?? "");
  fs.writeFileSync(path.join(home, ".bashrc"), "");
  const si = x(["shell", "install"]);
  const sourced = spawnSync("/bin/bash", ["-c", ". ~/.bashrc; complete -p xclaude"], { env, encoding: "utf8" });
  check("shell install", si.status === 0 && sourced.stdout.includes("_xclaude_complete"), sourced.stdout.trim());
  if (tmux) {
    const tn = x(["tmux", "new", "smoke", "--detach", "--empty"]);
    const tl = x(["tmux", "ls"]);
    const tk = x(["tmux", "kill", "smoke"]);
    check("tmux new --empty, ls, kill", tn.status === 0 && /^smoke\s/m.test(tl.stdout) && tk.status === 0, tl.stdout.trim().split("\n")[1] ?? tn.stderr.trim());
  } else check("tmux new --empty (tmux not installed: skipped)", true);
  const d = x(["doctor"]);
  check("doctor", d.status === 0, d.stdout.trim().split("\n").at(-1) ?? "");
  spawnSync(tmux ?? "tmux", ["kill-server"], { env, stdio: "ignore" });
} catch (e) {
  check("smoke test ran", false, (e as Error).message);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(tmuxTmp, { recursive: true, force: true });
}

for (const r of results) process.stdout.write(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? `: ${r.detail}` : ""}\n`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
