// The one-time question whether an account takes the ~/.claude login's setup:
// what ~/.claude/settings.json sets (link/inherit.ts), the plugins it has on
// (link/plugins.ts) and the MCP servers in ~/.claude.json (link/mcp.ts). The
// answer is the account's `inherit` in the config. The account's first launch
// in a terminal asks, and so does `add`; without a terminal the account stays
// as it is, and is told once how to choose.
import { type Config, loadConfig, saveConfig } from "../core/config.ts";
import type { Paths } from "../core/paths.ts";
import { loadState, updateState } from "../core/state.ts";
import type { Ctx } from "../ctx.ts";
import { inheritable, inheritStatus, listed, mainSettings } from "../link/inherit.ts";
import { mcpServersFor } from "../link/mcp.ts";
import { mainPlugins, planPlugins, trackedOf, userPlugins } from "../link/plugins.ts";
import { pick } from "./picker.ts";

/**
 * What taking ~/.claude's setup would bring into the account, one line per
 * part; empty when there's nothing to take, or when it can't be read (the
 * question waits for a launch that can). Works before the account's folder
 * exists, for `add`.
 */
export function setupPreview(paths: Paths, account: string): string[] {
  try {
    return previewLines(paths, account);
  } catch {
    return [];
  }
}

function previewLines(paths: Paths, account: string): string[] {
  const lines: string[] = [];
  const main = mainSettings(paths);
  if ("settings" in main) {
    const keys = inheritStatus(paths, account, main.settings)?.pending ?? Object.keys(inheritable(main.settings));
    if (keys.length) lines.push(`  settings  ${listed(keys)}`);
  }
  const on = mainPlugins(paths);
  if (on?.size) {
    const plan = planPlugins(paths, account, trackedOf(paths, account), on);
    const ids = plan ? plan.turnOn : (userPlugins(paths) ?? []).filter((id) => on.has(id.toLowerCase()));
    if (ids.length) lines.push(`  plugins   turns on ${listed(ids)}`);
  }
  const servers = Object.keys(mcpServersFor(paths, account) ?? {});
  if (servers.length) lines.push(`  MCP       ${listed(servers)}`);
  return lines;
}

/** Says once, at a launch without a terminal, how to choose; until then the account takes nothing. */
function noteOnce(ctx: Ctx, account: string): void {
  try {
    if (loadState(ctx.paths).inheritNoted.includes(account)) return;
    updateState(ctx.paths, (state) => {
      state.inheritNoted.push(account);
    });
  } catch {
    // The state is a convenience; never block a launch on it.
  }
  ctx.io.err(
    `xclaude: ${account} doesn't take ~/.claude's settings, plugins and MCP servers until you choose: launch it in a terminal, or run xclaude set ${account} --inherit on (or off)\n`,
  );
}

/**
 * The answer for an account that hasn't been asked: true or false, or
 * undefined when ~/.claude has nothing to give yet or there's no terminal to
 * ask in. Throws Cancelled on Esc.
 */
export async function askInherit(ctx: Ctx, account: string): Promise<boolean | undefined> {
  const preview = setupPreview(ctx.paths, account);
  if (!preview.length) return undefined;
  if (!ctx.tty.stdin || !ctx.tty.stderr) {
    noteOnce(ctx, account);
    return undefined;
  }
  ctx.io.err(`xclaude: ${account} can take what you set up for plain claude in ~/.claude:\n${preview.join("\n")}\n`);
  const choice = await pick(
    `Take it into ${account}?`,
    [
      { label: "Yes", detail: `now and at every launch; what ${account} changes itself stays` },
      { label: "No", detail: `leave ${account} as it is (later: xclaude set ${account} --inherit on)` },
    ],
    0,
  );
  if (choice === 0) return true;
  ctx.io.err(`xclaude: ${account} stays as it is; take ~/.claude's setup later with: xclaude set ${account} --inherit on\n`);
  return false;
}

/** Before a launch: asks an account that hasn't been asked, saves the answer and returns the config with it. */
export async function settleInherit(ctx: Ctx, config: Config, account: string): Promise<Config> {
  if (config.accounts[account]?.inherit !== undefined) return config;
  const take = await askInherit(ctx, account);
  if (take === undefined) return config;
  try {
    // Reload: another xclaude may have changed the config while this one asked.
    const fresh = loadConfig(ctx.paths, { create: false }).config;
    const defaults = fresh.accounts[account];
    if (!defaults) return config;
    defaults.inherit = take;
    saveConfig(ctx.paths, fresh);
    return fresh;
  } catch (e) {
    ctx.io.err(`xclaude: couldn't save ${account}'s answer (${(e as Error).message}); the next launch asks again\n`);
    const once = structuredClone(config);
    once.accounts[account]!.inherit = take;
    return once;
  }
}
