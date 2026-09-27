# xclaude architecture

How xclaude works, for anyone changing it; a change to behavior updates it in the same commit. What it says about Claude Code was checked against the real Claude Code (2.1.283) on Linux and macOS, except two things that are still assumptions: `--chrome` in two accounts at once, and `/ide` in an account session finding an editor that runs as plain `claude`. Code references are to `src/`.

## 1. The idea in one paragraph

Claude Code keeps everything, including the login, in one config dir, `~/.claude` by default, or `$CLAUDE_CONFIG_DIR`. The only documented way to run several claude.ai logins is one config dir per login. xclaude gives every account its own config dir, `~/.xclaude/accounts/<name>`, and inside it links the directories that hold conversations and personal content to `~/.claude`, the shared store. Two logins can run at once, each with its own credential and background supervisor, while they read and write the same transcripts, history, skills and plugins. Plain `claude` keeps using `~/.claude` directly, so nothing has to move.

## 2. Layout

```
~/.claude/                          shared store; also plain claude's config dir (the main identity)
~/.xclaude/                         $XCLAUDE_HOME
├── config.json                     accounts, defaults, share overrides, guard, tmux options (0600)
├── state.json                      last account per dir, seen unknown entries, installed version (0600)
├── cache/claude-help.json          parsed `claude --help`, keyed by binary path + mtime + size
├── shell/init.bash, init.zsh       generated shell integration
├── locks/store                     the store-wide repair lock (a directory)
└── accounts/<name>/                CLAUDE_CONFIG_DIR of <name> (0700); never moves
    ├── .credentials.json, .claude.json, settings.json, jobs/, daemon/, …   per account
    ├── CLAUDE.md                   import stub, while ~/.claude/CLAUDE.md exists
    ├── history.jsonl → realpath(~/.claude/history.jsonl)
    └── projects → realpath(~/.claude/projects)            (one link per shared directory)
```

**Notation.** `A` is an account's config dir, `S` the store (`~/.claude`) and `E` one shared entry, so `A/E` is, say, the account's `projects` and `S/E` the store's.

**`config.json`** is created on the first real command (never by `help` or `--version`) and written atomically:

```json
{
  "version": 1,
  "main": { "enabled": false, "model": null, "effort": null, "args": [] },
  "accounts": {
    "personal": { "model": null, "effort": null, "args": [] },
    "acme": { "model": "opus", "effort": "max", "args": ["--chrome"] }
  },
  "share": { "add": [], "remove": [] },
  "guard": false,
  "tmux": { "statusRight": true },
  "claudePath": null
}
```

- `add`, `set`, `rm`, `set main --enable|--disable` and `guard on|off` edit it; the rest is edited by hand. `main` is reserved and can't be an account name.
- `share.add` lists extra directory names to share, meant for entries xclaude doesn't know yet (the unknown-entry notice suggests it). Per-account entries are refused whatever their letter case (macOS volumes are case-insensitive, so `Jobs` is `jobs`), and so are names that look like files. `share.remove` stops sharing a built-in entry: the account's link becomes an empty real directory (an empty `0600` file for `history.jsonl`), and the content stays in the store.
- `claudePath` pins the `claude` binary (`XCLAUDE_CLAUDE_PATH` does the same for one run). `tmux.statusRight: false` leaves tmux's status bar alone.
- `state.json` (managed, and losing an update is harmless) holds the last account per directory, the last one used, the unknown entries already reported, and the installed version.
- Other environment variables: `XCLAUDE_HOME` moves `~/.xclaude`; `XCLAUDE_SWITCHES="name=1,name=0"` overrides the switches (§3) for one run; `XCLAUDE_MANAGED_SETTINGS_DIR` points `doctor` at another managed-settings directory (tests use it).

- **Removed accounts** (`link/leftover.ts`): `rm` deletes an account's login, settings and caches but keeps its links, because Claude Code records paths through the config dir it ran under, like saved tool outputs. It also keeps the account's own content under a shared name (its own skills while `skills` isn't shared), so nothing it made is lost. `rm <name>` on the leftover, or `rm --leftovers`, deletes it after a confirmation, re-checked afterwards, and only while it holds nothing but links and no tmux session of that account runs. Any other folder in `accounts/` (one holding a login or an interrupted merge, a name that couldn't be an account's, a symlink) is never deleted; `doctor` points it out, and `add` takes a valid one back.
- **Account folders are real folders:** one that's a symlink, or that is or holds the store, is refused by every repair, `add` and `rm`, since working through it would reach into `~/.claude` or wherever it points.
- **The config dir string is literal** (`core/paths.ts`): `path.join(<xclaude home>, "accounts", <name>)`, never `realpath`ed and never with a trailing slash. On macOS the Keychain entry is keyed to a hash of that exact string, so a different spelling is a different login.
- **Links point at real paths:** `realpath(~/.claude/E)`. If `~/.claude/skills` is itself a symlink (dotfiles), the account links straight to its target, so no link points at another link. A link to the literal `~/.claude/E` is also accepted.

## 3. The share table (`link/table.ts`)

| Shared as directory links | Why |
|---|---|
| `projects` | transcripts, subagent transcripts, tool results, auto memory: the core of continuing a conversation elsewhere |
| `sessions` | the registry of running sessions; lets Claude see a conversation open under another account |
| `session-env`, `file-history`, `tasks`, `todos`, `teams`, `plans` | per-session state that belongs to the conversation, e.g. `/rewind` checkpoints |
| `paste-cache`, `image-cache`, `uploads`, `downloads`, `debug` | content referenced from transcripts |
| `chrome` | Chrome integration files (two accounts at once untested; the `shareChrome` switch makes it per account) |
| `skills`, `agents`, `commands`, `rules`, `output-styles`, `themes`, `workflows`, `hooks`, `agent-memory`, `memory`, `plugins` | personal content; `memory` only while `~/.claude/memory` exists |

- `history.jsonl` is shared as a **file link**. It's appended to under a lock on its resolved path and never rewritten through the link (§6).
- `CLAUDE.md` is shared through an **import stub** (§7).
- **Never shared (invariant 4 in `CLAUDE.md`):** `.credentials.json`, `.claude.json(.backup)`, `settings.json`, `settings.local.json`, `keybindings.json`, `remote-settings.json`, `policy-limits.json`, `jobs`, `daemon`. `share.add` refuses them in any letter case (macOS volumes are case-insensitive), and refuses names that look like files.
- **Per account:** the above plus caches and process state (`backups`, `cache`, `shell-snapshots`, `stats-cache.json`, `usage-data`, `ide`, and everything else in Appendix A). `ide` isn't linked because Claude Code already scans `~/.claude/ide` when `CLAUDE_CONFIG_DIR` is set (seen in the binary; untested with an editor).
- **Switches:** `sessions`, `history.jsonl`, `skills`, `chrome` and `ide` follow switches (`switches.ts`), whose defaults the spike suite (`spikes/`, run against the real Claude Code) settled; `XCLAUDE_SWITCHES` overrides them for one run. `share.add` and `share.remove` come from the config. An entry that stops being shared becomes an empty real directory (or an empty `0600` file) in the account, and its content stays in the store.

## 4. The link engine (`link/repair.ts`)

It runs on every account launch, in `add`, `rm` and `doctor --fix`, and never for the main identity.

**Classification.** Each shared entry of an account gets one state: `ok`, `missing`, `store-missing` (a correct link whose target vanished), `link-elsewhere`, `real-dir`, `real-file` (history), `wrong-type`, `store-wrong-type`, `optional-absent` (`memory`) or `unshare`. The launch fast path takes well under a millisecond (0.1–0.3 ms measured): one `readdir` plus a few syscalls per entry, and no lock when everything is `ok`.

**Actions**, all under the store-wide lock `~/.xclaude/locks/store`:
- `missing` → create the store entry if needed, then `symlink`. `EEXIST` means someone was faster, and the entry is classified again.
- `store-missing` → recreate the store entry.
- `link-elsewhere` → reported; only `doctor --fix` replaces it (atomically: a temp link renamed over the old one).
- `real-dir` → directory merge (§5). `real-file` → history merge (§6).
- `unshare` → an empty directory, or an empty `0600` file swapped in atomically for `history.jsonl`.
- `wrong-type` and `store-wrong-type` → reported; a person has to decide.
- A store entry that resolves into an account dir is refused. It would make every account's link point at one account's copy, or at itself.

**Locks** (`core/lock.ts`) are `mkdir` locks, the same scheme as proper-lockfile. The holder refreshes the mtime; others take a lock over once it's stale (store lock: 30 s; history locks: 10 s, like Claude Code's). Ownership is checked by comparing the mtime with the one the holder last set. A launch waits at most 2 s for the store lock and otherwise skips repairs (the next launch retries). A holder that finds its lock taken over stops.

**Problems** are printed at launch (`xclaude: acme/skills links to …`), never fatal: Claude still starts.

## 5. Directory merge (`link/merge.ts`)

Used when a real directory sits where a link belongs, e.g. after `share.add`, a new release that shares a new entry, or something that replaced a link. **Link first, swap second**, so a running session of the same account keeps writing to the same inodes:

1. **Link pass** (`linkTree`), while `A/E` is still in place: `mkdir` for directories, a hard `link` for files, a recreated `symlink` for symlinks, all into `realpath(S/E)`. Nothing is moved or replaced. `link` fails with `EEXIST` rather than overwrite, which also catches case-only clashes on macOS. On a clash, the same inode (an interrupted earlier run) or identical content means nothing to do; different content gets `<name>.xclaude-conflict-<account>-<timestamp>`.
   - Any failure (`EXDEV` across filesystems, `EACCES`/`EPERM`/`EROFS` on a read-only store entry, …) undoes exactly what this pass created, checked by inode or link target, and leaves `A/E` untouched.
2. **Swap:** `rename A/E → A/.xclaude-merge-E-<ts>-<pid>-<n>`, then `symlink A/E → realpath(S/E)` at once. If a running session re-created `A/E` in between (`EEXIST`), that one is set aside too. Any other failure renames the aside back.
3. **Empty the aside** (`moveTree`): entries the link pass placed are just unlinked (the store has the same inode); anything created between the passes is moved with `link` + `unlink`, under the same clash rules. One exception to "never replace": when the account rewrote a file (a new inode) after the link pass, while the store name still holds exactly the inode this merge created, the newer version takes the name and the older one is kept as a conflict copy, so the account doesn't go back to its old file and nothing is lost.
4. Remove the empty aside, and print one summary line.

Apart from that exception, `rename` never moves content onto a name, because it silently replaces an existing file. Open file descriptors keep working, since `link` keeps the inode. An aside left by a crash is resumed by the next repair: identical inodes drop, anything else moves. If the entry is no longer shared by then, the content moves back into the account's own directory.

## 6. History merge (`link/history.ts`)

Claude Code appends each prompt to `history.jsonl` while holding a proper-lockfile lock on the file's **resolved** path (stale after 10 s). The merge takes the same locks:

1. Take the account's lock, `A/history.jsonl.lock`, and keep it fresh until the very end.
2. Hard-link `A/history.jsonl` to an aside, so its content survives the swap.
3. Swap in the link atomically: a temp symlink renamed over the file. From now on appends lock and write the store's file.
4. Take the store's lock at `realpath(S/history.jsonl) + ".lock"`.
5. Merge: drop exact duplicate lines, order by `timestamp` (entries without one stay after their predecessor), write a temp file with `fsync`, and rename it over the store's file. Abort, keeping the aside, if either lock was taken over.
6. Release the store's lock and remove the aside.
7. Release the account's lock **last**. A writer that resolved the old path before the swap waits for it and then appends through the link after the rewrite.

A resumed aside is merged again; duplicates drop, so that's harmless. The concurrent-writer test runs a real proper-lockfile writer during the merge and checks that every line it reported as written appears exactly once, with and without retries.

## 7. The CLAUDE.md stub (`link/stub.ts`)

While `~/.claude/CLAUDE.md` exists, each account has a `CLAUDE.md` containing:

```
Shared instructions live in ~/.claude/CLAUDE.md, so edit that file.
@~/.claude/CLAUDE.md
```

From directories under `$HOME`, `~/.claude/CLAUDE.md` also loads through Claude Code's ancestor walk (F12). Everywhere else only the import loads it. The stub is removed only while it's still exactly the stub, and a differing file is never touched (`doctor` points it out).

## 8. Unknown entries and path normalization

- **Unknown entries** (`link/unknown.ts`): names in an account dir that are in none of the share table, the per-account list or Appendix A stay per account. The first sighting prints one line and is recorded in `state.json`. Locks, `.xclaude-*`, `.DS_Store` and Claude Code's `*.tmp.*` files are ignored. `scripts/claude-state-entries.ts` diffs Appendix A against a new binary.
- **Path normalization** (`link/normalize.ts`, off: another account loads a plugin fine after the installing account's dir is gone): rewrites `<xclaude home>/accounts/<name>/…` to `$HOME/.claude/…` in JSON string values of `plugins/installed_plugins.json` and `plugins/known_marketplaces.json`. It plans first, re-checks the file under the store lock, and skips a file Claude Code wrote in between.

## 9. Launch (`launch/`)

`xclaude <account> [args…]`:
1. Resolve the account (the grammar or the picker; `main` only when enabled).
2. Link engine (regular accounts only), problems printed, unknown entries noted.
3. Find `claude`: `XCLAUDE_CLAUDE_PATH`, `claudePath`, the first `claude` on PATH whose real path isn't xclaude itself, then the fixed install locations. It's resolved every time, since auto-updates move the versioned file.
4. Arguments (`launch/args.ts`): if the first user argument is a Claude Code subcommand (the parsed `--help` plus a fallback list that includes the hidden `daemon`), the user arguments pass through unchanged. Otherwise `[account args] [--model M] [--effort E] [user args]`. Defaults are skipped when the user typed that flag, and user arguments come last, so they win. Account args that take values become `--flag=value`, one per value, so a variadic flag never swallows a prompt.
5. Environment: inherited, `CLAUDE_CONFIG_DIR` set (or removed for `main`), `CLAUDE_SECURESTORAGE_CONFIG_DIR` removed, `XCLAUDE_ACCOUNT` set.
6. Record the account for the directory in `state.json`.
7. `process.execve(claude, [claude, …args], env)`. A failed execve aborts Node before v26.1, so it's used only for a binary or a `#!` script whose interpreter is an existing binary, read the way the kernel reads it (a CRLF `\r` stays part of the name). A text script without `#!` runs as `/bin/sh <script>`, as shells do, everywhere claude is started (glibc's `execvp` does that by itself, macOS's `posix_spawn` doesn't); anything else goes through the spawn fallback, and an empty file is refused. The spawn fallback (the `spawnFallback` switch) ignores SIGINT/SIGQUIT, forwards SIGTERM/SIGHUP and ends the same way the child did.

**The terminal is handed over untouched.** Node reopens a terminal it reads from as non-blocking, even on a mere `process.stdin.isTTY`, and the exec'd program would inherit that on fd 0. xclaude therefore uses `tty.isatty()`, writes with `fs.writeSync`, and reads picker keys from its own `/dev/tty` descriptor (paused and unref'd afterwards, not destroyed: Node's socket teardown would create `process.stderr` and reopen fd 2). A test compares the flags `claude` receives on fds 0–2 with a direct run.

**The picker** (`launch/picker.ts`) is a pure state machine with a renderer on stderr: ↑/↓ or j/k, 1–9, Enter, Esc or Ctrl-C (exit 130). It preselects the account last used in the directory, then the most recent one.

## 10. tmux (`tmux/`, `commands/tmux.ts`)

- Sessions are named `xclaude-<account>_<label>` (`xclaude--<label>` for `--empty`); `_` can't appear in account names, so names never collide. They're **found by `@xclaude=1`**, never by name, and targeted by session id. tmux itself is the only record.
- The command is typed into the session's shell with `send-keys -l`, then `Enter`, so quitting Claude leaves a shell and up-arrow reruns it.
- tmux runs without the account variables and without Claude Code's per-session variables (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, the messaging socket, …). A server started from inside a Claude session must not mark its shells as nested sessions.
- A trailing `;` in an argument is escaped as `\;` (tmux would read a command separator). Format output uses `|` separators with the free-text directory last, since tmux escapes control characters.
- The `CLAUDE` column comes from `claude agents --json` (one call; per account behind a switch). Each live pid is mapped to its session by walking parent pids up to a pane pid (`/proc` on Linux, one `ps` call on macOS), and the most urgent state wins: needs input > working > idle.

## 11. Shell integration (`shell/`)

- `shell install` targets `~/.zshrc` (under `$ZDOTDIR` when set) and `~/.bashrc`, whichever exist, or the ones asked for with `--zsh`/`--bash`; on macOS also `~/.bash_profile` when it exists and doesn't source `~/.bashrc`.
- The rc block only sources `~/.xclaude/shell/init.<shell>`, so the rc file is edited once. Symlinked rc files are edited at their target; read-only ones get the block printed for a manual install.
- The init files are regenerated on `shell install`, on `guard on|off`, and on the first run after an update. Each starts with `command -v xclaude || return 0`, so a leftover block is harmless.
- **Completion** is a thin shim that calls `xclaude __complete <shell> <cword> <words…>`, which answers with a directive (`default`, `files`, `dirs`, `nospace`) and candidates. That's about 25 ms, and `--help` parsing is cached. bash's `COMP_WORDBREAKS` split of `--flag=value` is joined back in Node, which answers with only the part readline replaces. The bash shim targets bash 3.2 (no `compopt`, `mapfile` or associative arrays) and is tested in the `bash:3.2` image. zsh registers from a one-shot `precmd` hook, so a later `compinit` can't wipe the `compdef`, and it's tested interactively in tmux.
- **Guard:** a `claude()` function that passes through when `XCLAUDE_ACCOUNT` or `CLAUDE_CODE_CHILD_SESSION` is set, or when xclaude isn't installed.

## 12. Known limitations

- `.claude.json` and `settings.json` are per account: MCP servers, folder trust, plugins, hooks and the statusline are set per account.
- Opening the same conversation in two terminals at once can corrupt it, and Claude Code shows no warning when the other terminal runs another account. Two accounts using `--chrome` at once may fight over the native-messaging manifest (untested).
- A machine with `forceLoginOrgUUID` refuses other orgs' logins (`doctor` reports it). An org's server-managed `cleanupPeriodDays` sweeps everyone's shared transcripts when that account runs (`doctor` warns below 30 days).
- `history.jsonl` isn't pruned while it's only reached through links (Claude Code skips symlinked history when pruning).
- Launching from `$HOME` makes `~/.claude/settings.json` that session's project settings. Under `$HOME`, the ancestor walk also finds `~/.claude/CLAUDE.md` and `rules/`, but Claude Code loads each file once.
- Plugins and tool results record paths inside the account dir that wrote them (F23). Plugins don't depend on them, but saved tool outputs do, so `rm` keeps the account's links. Once that leftover is deleted, the account's old conversations can't reopen their saved long outputs (the start still shows in the conversation, and the files stay in `~/.claude`).
- The store and `~/.xclaude` must be on one filesystem for merges (hard links); `doctor` warns otherwise.
- **Residual races, accepted:**
  - A history writer that resolved the old path, waited out the account's lock and appended without the store's lock could, in a roughly one-second window, collide with another account's history merge.
  - Two processes taking over the same stale lock at the same moment can both proceed (proper-lockfile has the same race). A holder that notices it lost the lock stops without undoing anything, and merges never read through links or overwrite, so directory merges lose nothing; a history rewrite racing another process's rewrite could drop the lines appended in between.

## 13. Facts the design relies on

"Observed" means seen in the Claude Code binary (v2.1.282), "Doc" Claude Code's documentation, "Issue" an issue in anthropics/claude-code, and "tested" checked by xclaude's tests or spike runs. The ones xclaude depends on were re-checked with 2.1.283 on Linux and macOS.

| # | Fact | Confidence |
|---|---|---|
| F1 | `CLAUDE_CONFIG_DIR` relocates the whole config dir, `.claude.json` and the `/login` credential included (`.credentials.json` on Linux; on macOS a Keychain entry keyed to the dir). | Doc |
| F2 | One config dir per account is the documented way to run several accounts (anthropics/claude-code #20131, #24963). | Issue |
| F3 | The background supervisor runs per config dir, with state in `jobs/` and `daemon/`. | Doc |
| F4 | `claude agents --json` lists live sessions (and working or blocked background ones) with `cwd`, `kind`, `pid`, `status`, `waitingFor`…, but no account. | Doc |
| F5 | `--resume <id>` also searches other projects (v2.1.223+); `--continue` is limited to the current directory. | Doc |
| F6 | Auto memory lives in `projects/<project>/memory/`. | Doc |
| F7 | `@imports` in the user-level `CLAUDE.md` load without an approval prompt. | Doc |
| F8 | `--model`/`--effort` apply to one session; `--effort` takes six values; `CLAUDE_CODE_EFFORT_LEVEL` beats the saved level, and `--effort` beats it (current docs). | Doc |
| F9 | `cleanupPeriodDays` (default 30) sweeps transcripts and more; server-managed settings can set it. | Doc |
| F10 | Atomic writes replace a symlinked file with a regular one; links to individual folders inside `projects/` broke several features. | Issue |
| F11 | Synced skills live in `skills/synced/`, removed ones in `skills/.trash`. | Doc / Issue |
| F12 | `~/.claude/CLAUDE.md` and `rules/` also load through the ancestor walk from under `$HOME`; `settings.json` only from `$HOME` itself. | Issue / Observed |
| F13 | Prompt history is appended under a proper-lockfile lock on the file's resolved path (stale 10 s); pruning skips a symlinked `history.jsonl`. | Observed |
| F14 | Claude Code knows 62 state entries of its own (Appendix A below); a storage backend sits behind a startup gate (not active in 2.1.283). | Observed |
| F15 | Chrome integration uses one native-messaging manifest per browser, rewritten by a session with a different config dir. | Doc |
| F16 | `claude auth status` prints JSON (`email`, `orgId`, `orgName`) and exits 0/1; `claude daemon stop --any` stops the supervisor. | Doc |
| F17 | Hooks and the statusline get no account field but inherit the environment (`XCLAUDE_ACCOUNT`). | Doc |
| F18 | The VS Code extension runs its own CLI; its `environmentVariables` setting can set `CLAUDE_CONFIG_DIR`. | Doc |
| F19 | The native install is `~/.local/bin/claude` → `~/.local/share/claude/versions/<v>`; npm, Homebrew and apt/dnf/apk also exist. | Doc |
| F20 | `process.execve` exists since Node 22.15 (experimental); argv[0] must be passed; before Node 26.1 a failed call aborts the process. | Doc / tested |
| F21 | The macOS Keychain entry is keyed to the literal `CLAUDE_CONFIG_DIR` string; `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides it. | Observed |
| F22 | `CLAUDE_CODE_CHILD_SESSION=1` (and `CLAUDECODE=1`) are set in the processes Claude Code spawns. | Doc / Observed |
| F23 | Shared data records paths under the writing account's dir (plugin registry, tool results). Spike 13 found that plugins resolve under the reading account's own dir, while saved tool outputs are opened through the recorded path. | Observed / tested |
| F24 | With `CLAUDE_CONFIG_DIR` set, Claude Code also scans `~/.claude/ide`. | Observed |

**Sources:** Claude Code's docs at code.claude.com/docs/en/ (authentication, claude-directory, agent-view, sessions, memory, model-config, settings-reference, env-vars, data-usage, chrome, hooks, statusline, cli-reference, setup, troubleshoot-install, managed-settings, vs-code), its CHANGELOG, Node's `process` docs, and anthropics/claude-code issues #20131, #24963, #30230, #47056, #55456, #31649, #40857, #88307, #15786, #3575, #51488, #96690, #96511, #97062, #96321, #14836, #95373, #88405, #90523, #22166 and #29051.

## 14. Claude Code's own state entries (Appendix A)

Kept per account unless the share table lists them (`APPENDIX_A` in `link/table.ts`; `scripts/claude-state-entries.ts` diffs it against a new binary):

`.claude.json`, `.claude.json.backup`, `.credentials.json`, `projects`, `sessions`, `todos`, `shell-snapshots`, `statsig`, `file-history`, `history.jsonl`, `ide`, `logs`, `backups`, `.session_ingress_token`, `policy-limits.json`, `remote-settings.json`, `hfi-auth.json`, `daemon`, `jobs`, `teams`, `usage-data`, `shares`, `state`, `uploads`, `feedback`, `feedback-bundles`, `plans`, `telemetry`, `dump-prompts`, `debug`, `traces`, `startup-perf`, `cache`, `mcp-discovery-cache`, `mcp-needs-auth-cache.json`, `gh-pr-status-cache.json`, `tasks`, `local`, `antproto.json`, `ccr`, `session-env`, `bridge-spawn`, `active-time.json`, `loop.md`, `server-sessions.json`, `image-cache`, `paste-cache`, `file-transfers`, `mcp-skill-archives`, `stats-cache.json`, `computer-use.lock`, `server.lock`, `api-dumps`, `chrome`, `downloads`, `local-settings`, `project-settings`, `remote`, `scratch`, `seed-admin`, `storage-v2`, `systemd`; plus `daemon.log*` and `policy-limits.json.stamp.json`.
