# xclaude-cli

`xclaude` (npm package `xclaude-cli`) runs Claude Code under several claude.ai logins: one `CLAUDE_CONFIG_DIR` per account (`~/.xclaude/accounts/<name>`), while conversations, history and personal content are shared through links into `~/.claude`. It's a personal tool with one user (the owner), published on npm for easy installs, and it must work with the latest Claude Code on any macOS or Linux machine.

## Where things are written down

- **Architecture (the reference):** [docs/architecture.md](docs/architecture.md), with the facts about Claude Code (F1–F24) it rests on. A change to behavior updates it in the same commit, along with the README and `xclaude help` where they're affected.
- **Spike suite:** [spikes/](spikes/README.md) checks xclaude against the real Claude Code; run logs go to `spikes/results/` (not committed).

## Commands

```sh
npm run build          # bundle src/cli.ts into dist/xclaude.js (esbuild)
npm run typecheck      # tsc, no emit
npm test               # node:test, test/**/*.test.ts; end-to-end tests run dist/, so build first
npm run check          # all three; a task is done when this passes
npm run check:node22   # the same on Node 22.15 (downloaded into node_modules/.cache)
node --experimental-strip-types spikes/run.ts --help   # the spike suite
```

Full coverage needs tmux, zsh and Docker (for the `bash:3.2` image); their tests skip loudly when the tool is missing. A zsh outside the standard prefix needs `FPATH` (its function dirs) and `XCLAUDE_TEST_ZSH_MODULES` (its module dir) in the environment.

## Repo map

```
src/cli.ts          entry: runtime-check.ts (runtime.ts: Node and platform) first, then main()
src/main.ts         dispatch; grammar.ts is the first-word grammar; version.ts is set by the build
src/ctx.ts          Ctx: env, paths, io, tty, switches, exec — everything a test can substitute
src/switches.ts     the switches the spikes settled
src/core/           paths, config, state, fsutil (atomic write, no-clobber move, tree removal),
                    lock (mkdir locks), sleep, options, shellwords, format, prompt, io, errors
src/link/           table (share table), repair (per-entry states and actions), merge (link-first
                    directory merge), history (history merge), stub, unknown, normalize,
                    leftover (what rm keeps of a removed account)
src/claude/         resolve (find claude), help (parse and cache --help), auth (auth status, runClaude)
src/launch/         launch pipeline, args, env, exec (execve, spawn fallback, runChild), picker
src/commands/       add, set, ls, rm, tmux, shell, guard, doctor, help, hidden (__complete, __names),
                    defaults (--model/--effort/--args parsing shared by add and set)
src/tmux/           client (env stripping, `;` escaping), sessions, claude-state (CLAUDE column)
src/shell/          rc (rc block), init (bash 3.2 and zsh shims, guard), complete (__complete)
test/               suites by area; helpers/ (sandbox, ctx, tmux, accounts, process runners),
                    fake-claude/claude.mjs, fixtures/claude-help.txt
spikes/             the spike suite; never shipped
scripts/            build.mjs (bundle), check-node22.sh, smoke-rc.ts (pack, install, smoke-test),
                    claude-state-entries.ts (diff Appendix A against a new Claude Code)
docs/architecture.md  how it all works
```

## Switches

All in `src/switches.ts`, each default settled by a spike run. `XCLAUDE_SWITCHES="name=1,name=0"` overrides them for one run (tests use it; so can anyone rerunning a spike):

| Switch | Default | Spike | Effect |
|---|---|---|---|
| `shareSessions` | on | 3 | off: `sessions` per account |
| `agentsPerAccount` | off | 3 | on: `claude agents --json` once per account |
| `shareHistory` | on | 4 | off: `history.jsonl` per account |
| `shareSkills` | on | 5 | off: `skills` per account |
| `shareChrome` | on | 7 | off: `chrome` per account |
| `spawnFallback` | off | 9 | on: spawn claude as a child instead of `execve` |
| `linkIde` | off | 11 | on: link `ide` too |
| `normalizePaths` | off | 13 | on: rewrite account-dir paths in the plugin registry |
| `keepSameEmailLogin` | off | 14 | on: `rm` skips logout when another identity has the same email (spike 14 showed that's not needed) |

## Rules

**Spike results.** When a rerun fails a go/no-go spike (1, 6, 8, 12), shows that a resumed conversation can't reopen its large tool outputs (13), or finds files loaded twice under `$HOME` (2), stop and decide with the owner. Otherwise flip the switch or apply the fallback, and report it.

**Tests never touch the real environment.** Every test builds the child environment from an allowlist (`test/helpers/sandbox.ts`): temp `HOME`, `XCLAUDE_HOME`, `TMUX_TMPDIR` (a private tmux server), `XDG_CONFIG_HOME`, and `XCLAUDE_CLAUDE_PATH` pointing at the fake `claude`. Never inherit `process.env` in a test, and never pass it to code under test. In-process tests use `test/helpers/ctx.ts`.

**Never touch Node's stdio streams before exec.** Accessing `process.stdin` (even `.isTTY`) reopens a terminal fd 0 as non-blocking, and `claude` inherits it through `execve`. Use `tty.isatty(fd)` and `fs.writeSync`; the picker reads keys from its own `/dev/tty` descriptor. `test/launch/picker.test.ts` checks the descriptors claude receives.

**Commits.** One commit per task, with a message of at most 10 words (fewer when possible) that reads like a person wrote it. Never mention Claude or AI, and add no trailers: no `Co-Authored-By`, no `Claude-Session`, no "Generated with". `.claude/settings.json` switches off Claude Code's attribution; keep it that way.

**Releases are the owner's.** Pushing, `npm version`, tags and `npm publish` are done by the owner only: an agent never runs them, and tells the owner what to run instead. Every npm version has a matching git tag, `v<version>` (`v0.1.0`), on its release commit, and `npm version` makes both. Fixes ship as patch versions (0.1.1, 0.1.2, …):

```sh
npm version <x.y.z> -m "Release %s"   # package.json and the lockfile, a "Release x.y.z" commit, the tag vx.y.z
node --experimental-strip-types scripts/smoke-rc.ts   # packs it, installs it into a scratch prefix, smoke-tests it
npm publish                           # builds dist/ first (prepack); asks for the 2FA code
git push --follow-tags                # the commit and its tag, after a successful publish
```

## Invariants

1. Deletion never follows links, and content is never moved with `rename` onto an existing path. (One narrow exception, `docs/architecture.md` §5: a merge gives a name it created itself to the account's newer version of that file, after keeping the older one as a conflict copy.) Nothing is ever read or emptied through a link.
2. An account's `CLAUDE_CONFIG_DIR` is the exact `path.join` string, never passed through `realpath`.
3. Links point at the real path of the store entry, so no link points at another link.
4. Credentials, `.claude.json`, `settings.json`, `jobs` and `daemon` are never shared.
5. Zero runtime dependencies, Node ≥ 22.15, and macOS and Linux only.
6. Generated bash code runs on bash 3.2.
7. Tests and spikes never write to the owner's real environment: `~/.claude`, `~/.xclaude`, rc files, the tmux server, the global npm prefix, the Chrome manifest or the Keychain. The only exceptions are spikes 7 and 11, which use the real home after a backup, and any spike run on macOS, whose test logins live in the login keychain until the run removes them (it asks first).
8. Arguments the user types always win over injected defaults.
9. Work only from this repository and public documentation. Never open, search or copy from the owner's other projects, and don't make this one resemble them. Give the same rule to every subagent.
10. Commits look like a person wrote them (see Commits above).
11. Only the owner pushes, tags and publishes, and every npm version has its `v<version>` tag (see Releases above).

## When Claude Code releases a new version

1. Run `xclaude doctor` with a couple of accounts and look for new unknown entries (they also print once at launch).
2. Compare Appendix A with the binary's own list of state entries: `node --experimental-strip-types scripts/claude-state-entries.ts [binary]` prints what's new and what's gone. New entries go into `APPENDIX_A` in `src/link/table.ts` (and Appendix A in `docs/architecture.md`), or into the share table if they should be shared.
3. Rerun spikes 1, 4, 6 and 12: `node --experimental-strip-types spikes/run.ts --only 1,4,6,12`.
4. Refresh the help fixture under a scratch home: `env -i HOME=$(mktemp -d) PATH=/usr/bin:/bin <binary> --help > test/fixtures/claude-help.txt`, then `npm run check`.
