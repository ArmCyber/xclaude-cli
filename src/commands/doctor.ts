// xclaude doctor [--fix]: reports everything that could keep xclaude
// from working and exits non-zero if something is wrong. Warnings and
// information never fail it. --fix applies the link repairs first.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type AuthStatus, authStatus, describeLogin } from "../claude/auth.ts";
import { findClaude, INSTALL_HINT } from "../claude/resolve.ts";
import { type Config, defaultConfig, identities, loadConfig, MAIN } from "../core/config.ts";
import { EXIT_ERROR, EXIT_OK, UsageError, XError } from "../core/errors.ts";
import { lstatOrNull, readFileOrNull, statOrNull } from "../core/fsutil.ts";
import { parseOptions } from "../core/options.ts";
import { accountDir, tildify } from "../core/paths.ts";
import type { Ctx } from "../ctx.ts";
import { identityEnv } from "../launch/env.ts";
import { normalizePaths } from "../link/normalize.ts";
import { strayFolders } from "../link/leftover.ts";
import { describeProblems, inspectAccount, repairAccount } from "../link/repair.ts";
import { SHARED_DIRS, shareTable } from "../link/table.ts";
import { storeUnknownEntries, unknownEntries } from "../link/unknown.ts";
import { installedIn } from "../shell/rc.ts";
import { findTmux, Tmux, TMUX_INSTALL_HINT } from "../tmux/client.ts";

type Level = "ok" | "info" | "warn" | "error";

const MARK: Record<Level, string> = { ok: "✓", info: "·", warn: "!", error: "✗" };

class Report {
  readonly lines: string[] = [];
  errors = 0;
  warnings = 0;

  section(title: string): void {
    this.lines.push(this.lines.length ? `\n${title}` : title);
  }

  add(level: Level, text: string, indent = 1): void {
    if (level === "error") this.errors++;
    if (level === "warn") this.warnings++;
    this.lines.push(`${"  ".repeat(indent)}${MARK[level]} ${text}`);
  }
}

/** Where machine-managed settings live. Tests point XCLAUDE_MANAGED_SETTINGS_DIR elsewhere. */
function managedDirs(ctx: Ctx): { dirs: string[]; macDefaults: boolean } {
  if (ctx.env.XCLAUDE_MANAGED_SETTINGS_DIR) return { dirs: [ctx.env.XCLAUDE_MANAGED_SETTINGS_DIR], macDefaults: false };
  if (process.platform === "darwin") return { dirs: ["/Library/Application Support/ClaudeCode"], macDefaults: true };
  return { dirs: ["/etc/claude-code"], macDefaults: false };
}

/**
 * The forceLoginOrgUUID that Claude Code applies, with where it comes from. The
 * macOS preferences (MDM) come before the files; managed-settings.json and then
 * managed-settings.d/*.json in alphabetical order merge: a single value
 * replaces, a list adds to a list.
 */
export function readForcedOrgs(ctx: Ctx): { source: string; orgs: string[] } | null {
  const { dirs, macDefaults } = managedDirs(ctx);
  if (macDefaults) {
    const res = spawnSync("defaults", ["read", "com.anthropic.claudecode", "forceLoginOrgUUID"], { encoding: "utf8", timeout: 5_000 });
    const orgs = res.status === 0 ? [...(res.stdout ?? "").matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((m) => m[0]) : [];
    if (orgs.length) return { source: "the com.anthropic.claudecode preferences", orgs };
  }
  const files: string[] = [];
  for (const dir of dirs) {
    files.push(path.join(dir, "managed-settings.json"));
    try {
      for (const name of fs.readdirSync(path.join(dir, "managed-settings.d")).sort()) {
        if (name.endsWith(".json")) files.push(path.join(dir, "managed-settings.d", name));
      }
    } catch {
      // no drop-in directory
    }
  }
  let orgs: string[] | null = null;
  let isList = false;
  let sources: string[] = [];
  for (const file of files) {
    const text = readFileOrNull(file);
    if (text === null) continue;
    let value: unknown;
    try {
      value = (JSON.parse(text) as { forceLoginOrgUUID?: unknown }).forceLoginOrgUUID;
    } catch {
      continue; // an unreadable file is Claude Code's to report
    }
    if (typeof value === "string") {
      orgs = [value];
      isList = false;
      sources = [file];
    } else if (Array.isArray(value)) {
      const list = value.filter((v): v is string => typeof v === "string");
      if (isList && orgs) {
        orgs = [...orgs, ...list];
        sources.push(file);
      } else {
        orgs = list;
        sources = [file];
      }
      isList = true;
    }
  }
  return orgs && orgs.length ? { source: sources.join(" and "), orgs } : null;
}

/** A server-managed cleanupPeriodDays from an account's remote-settings.json, if any. */
export function remoteCleanupDays(dir: string): number | null {
  try {
    const json = JSON.parse(readFileOrNull(path.join(dir, "remote-settings.json")) ?? "null") as Record<string, unknown> | null;
    const value = json?.cleanupPeriodDays ?? (json?.settings as Record<string, unknown> | undefined)?.cleanupPeriodDays;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

function versionOf(bin: string, args: string[]): string | null {
  const res = spawnSync(bin, args, { encoding: "utf8", timeout: 15_000 });
  return res.status === 0 ? (res.stdout ?? "").trim().split("\n")[0] || null : null;
}

export async function doctorCommand(ctx: Ctx, args: string[]): Promise<number> {
  const p = parseOptions(args, { fix: {} }, "doctor");
  if (p.positionals.length) throw new UsageError("usage: xclaude doctor [--fix]");
  const home = ctx.paths.home;
  const t = (p2: string) => tildify(p2, home);
  const report = new Report();

  // Config first: everything else depends on it, but a broken one is a finding, not a crash.
  let config: Config = defaultConfig();
  let configProblem: string | null = null;
  try {
    config = loadConfig(ctx.paths, { create: false }).config;
  } catch (e) {
    if (!(e instanceof XError)) throw e;
    configProblem = e.message;
  }
  const table = shareTable(config, ctx.switches);

  if (p.values.fix && !configProblem) {
    const log = (line: string) => ctx.io.err(`${line}\n`);
    for (const name of Object.keys(config.accounts)) {
      repairAccount({ paths: ctx.paths, account: name, table, lockWaitMs: Infinity, replaceWrongLinks: true, log });
    }
    if (ctx.switches.normalizePaths && table.dirs.includes("plugins")) normalizePaths(ctx.paths, { lockWaitMs: Infinity, log });
  }

  // Tools
  report.section("Tools");
  let claude: string | null = null;
  try {
    claude = findClaude(ctx.env, config, home, ctx.selfPath);
    report.add("ok", `claude ${versionOf(claude, ["--version"]) ?? "(version unknown)"} at ${t(claude)}`);
  } catch (e) {
    if (!(e instanceof XError)) throw e;
    report.add("error", e.message.includes("isn't installed") ? `Claude Code isn't installed; ${INSTALL_HINT}` : e.message);
  }
  const tmuxBin = findTmux(ctx.env);
  if (!tmuxBin) report.add("warn", `tmux isn't installed, so xclaude tmux won't work (it needs 3.0 or later); ${TMUX_INSTALL_HINT}`);
  else {
    const v = new Tmux(ctx.env).version();
    if (v && v[0] < 3) report.add("warn", `tmux ${v.join(".")} is too old for xclaude tmux (it needs 3.0 or later)`);
    else report.add("ok", `tmux ${v ? v.join(".") : "(version unknown)"}`);
  }
  report.add("ok", `Node ${process.versions.node}`);

  // Config
  report.section("Config");
  if (configProblem) report.add("error", configProblem);
  else report.add("ok", `${t(ctx.paths.config)}${fs.existsSync(ctx.paths.config) ? "" : " (not created yet)"}`);
  for (const name of table.refused) report.add("warn", `share.add "${name}" is ignored: never-shared entries and file names can't be shared`);

  // Logins, all identities in parallel.
  const names = identities(config);
  const logins = new Map<string, AuthStatus>();
  if (claude) {
    const statuses = await Promise.all(names.map((n) => authStatus(claude!, identityEnv(ctx, n))));
    names.forEach((n, i) => logins.set(n, statuses[i]!));
  }
  const forced = readForcedOrgs(ctx);

  // Accounts
  report.section("Accounts");
  if (configProblem) report.add("info", "not checked: fix the config first (account dirs are left alone)");
  else if (!names.length) report.add("info", "no accounts yet; add one with: xclaude add <name>");
  const storeDev = statOrNull(ctx.paths.store)?.dev;
  for (const name of names) {
    const login = logins.get(name);
    report.lines.push(`  ${name}${login ? `  ${describeLogin(login)}` : ""}`);
    if (name === MAIN) {
      report.add("info", "the main identity: the login in ~/.claude, never linked", 2);
    } else {
      const dir = accountDir(ctx.paths, name);
      const insp = lstatOrNull(dir)?.isSymbolicLink() ? null : inspectAccount(ctx.paths, name, table, true);
      if (!insp) {
        report.add("error", `${t(dir)} is a symlink; xclaude only manages real folders there, so it leaves this one alone`, 2);
      } else if (!insp.exists) {
        report.add("error", `${t(dir)} is missing; the next launch (or --fix) recreates it, then log in again`, 2);
      } else {
        const problems = describeProblems(insp, ctx.paths);
        if (problems.length) {
          for (const pr of problems) report.add("error", `${pr.entry} ${pr.message}`, 2);
        } else report.add("ok", `links into ${t(ctx.paths.store)}`, 2);
        if (insp.stub === "differs") {
          report.add("warn", "CLAUDE.md isn't the import stub, so it's left alone; move what it says into ~/.claude/CLAUDE.md to share it", 2);
        } else if (insp.stub === "create" || insp.stub === "remove") {
          report.add("error", `the CLAUDE.md stub needs ${insp.stub === "create" ? "creating" : "removing"}; run xclaude doctor --fix`, 2);
        }
        const unknown = unknownEntries(insp.names, table);
        if (unknown.length) report.add("info", `per-account entries xclaude doesn't know: ${unknown.join(", ")}`, 2);
        const dev = statOrNull(dir)?.dev;
        if (storeDev !== undefined && dev !== undefined && dev !== storeDev) {
          report.add(
            "warn",
            `${t(ctx.paths.store)} and ${t(dir)} are on different filesystems, so left-behind directories can't be merged (hard links don't cross filesystems); keep ~/.claude and ~/.xclaude on one filesystem`,
            2,
          );
        }
        const days = remoteCleanupDays(dir);
        if (days !== null && days < 30) {
          report.add("warn", `its organization sets cleanupPeriodDays to ${days}: its sessions delete everyone's shared transcripts older than ${days} days`, 2);
        }
      }
    }
    if (login) {
      if (login.error) report.add("warn", `login status unknown: ${login.error}`, 2);
      else if (!login.loggedIn) report.add("warn", `not logged in; run: xclaude ${name} auth login`, 2);
      if (forced && login.loggedIn && login.orgId && !forced.orgs.includes(login.orgId)) {
        report.add("error", `forceLoginOrgUUID (from ${t(forced.source)}) excludes this login's organization (${login.orgName ?? login.orgId}), so it will be refused`, 2);
      }
    }
  }
  const byLogin = new Map<string, string[]>();
  for (const [n, s] of logins) {
    if (s.loggedIn && s.email) byLogin.set(`${s.email}\n${s.orgId}`, [...(byLogin.get(`${s.email}\n${s.orgId}`) ?? []), n]);
  }
  for (const [key, same] of byLogin) {
    if (same.length > 1) report.add("warn", `${same.join(" and ")} use the same login (${key.split("\n")[0]})`);
  }
  // Folders that aren't accounts: normally just the links rm keeps of a removed one.
  for (const f of configProblem ? [] : strayFolders(ctx.paths, config)) {
    const where = t(f.dir);
    if (f.kind === "leftover") {
      report.add("info", `${where}: links kept from the removed account ${f.name}, for its old conversations; delete with: xclaude rm ${f.name}`);
    } else if (f.kind === "content") {
      report.add("warn", `${where} isn't an account but holds more than links (${f.entries.join(", ")}): \`xclaude add ${f.name}\` takes it back, or check it and delete it by hand`);
    } else if (f.kind === "stray") {
      report.add("info", `${where} isn't an account folder (that name couldn't be one); check it by hand`);
    } else {
      report.add("warn", `${where} is a symlink; xclaude only manages real folders there`);
    }
  }

  // Store (informational only)
  report.section("Store");
  const storeUnknown = storeUnknownEntries(ctx.paths.store, table);
  if (!fs.existsSync(ctx.paths.store)) report.add("info", `${t(ctx.paths.store)} doesn't exist yet`);
  else if (storeUnknown.length) report.add("info", `entries in ${t(ctx.paths.store)} that no account links to: ${storeUnknown.join(", ")}`);
  else report.add("ok", t(ctx.paths.store));
  const mainDays = remoteCleanupDays(ctx.paths.store);
  if (mainDays !== null && mainDays < 30) {
    report.add("warn", `the ~/.claude login's organization sets cleanupPeriodDays to ${mainDays}: plain claude deletes everyone's shared transcripts older than ${mainDays} days`);
  }
  for (const entry of SHARED_DIRS) {
    const p2 = path.join(ctx.paths.store, entry);
    if (!fs.existsSync(p2)) continue;
    try {
      fs.accessSync(p2, fs.constants.W_OK);
    } catch {
      report.add("warn", `${t(p2)} isn't writable, so sessions can't save ${entry} there`);
    }
  }

  // Shell
  report.section("Shell");
  const rcFiles = installedIn(ctx.env, home);
  if (rcFiles.length) report.add("ok", `completion loaded from ${rcFiles.map(t).join(", ")}`);
  else report.add("info", "completion isn't installed (xclaude shell install)");
  report.add("info", `guard: ${config.guard ? "on" : "off"}`);

  // Environment
  report.section("Environment");
  let envFindings = 0;
  if (ctx.env.CLAUDE_CONFIG_DIR) {
    report.add("warn", `CLAUDE_CONFIG_DIR is set (${ctx.env.CLAUDE_CONFIG_DIR}), so plain \`claude\` doesn't use ~/.claude`);
    envFindings++;
  }
  if (ctx.env.CLAUDE_CODE_EFFORT_LEVEL) {
    report.add("warn", `CLAUDE_CODE_EFFORT_LEVEL is set (${ctx.env.CLAUDE_CODE_EFFORT_LEVEL}); it overrides the effort level saved in every account's settings`);
    envFindings++;
  }
  if (!envFindings) report.add("ok", "nothing that overrides accounts");

  report.lines.push("");
  const summary =
    report.errors || report.warnings
      ? `${report.errors} problem${report.errors === 1 ? "" : "s"}, ${report.warnings} warning${report.warnings === 1 ? "" : "s"}${report.errors && !p.values.fix ? ". Run `xclaude doctor --fix` to repair what can be repaired." : "."}`
      : "All good.";
  report.lines.push(summary);
  ctx.io.out(`${report.lines.join("\n")}\n`);
  return report.errors ? EXIT_ERROR : EXIT_OK;
}
