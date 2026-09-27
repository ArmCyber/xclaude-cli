# spikes

The spike suite checks xclaude against the real Claude Code. Run it after a Claude Code update:

```sh
node --experimental-strip-types spikes/run.ts --help
node --experimental-strip-types spikes/run.ts            # two logins, then ~15 min unattended
node --experimental-strip-types spikes/run.ts --only 6,13
node --experimental-strip-types spikes/run.ts --fake     # a rehearsal with the fake claude, no logins
```

Everything runs under a scratch `HOME`, with the package installed into a scratch npm prefix and a private tmux server. On macOS the scratch home links `~/Library/Keychains`, so the test logins go into your login keychain until the run removes them (it asks first). Results go to `spikes/results/`, which isn't committed. `spike9-execve.mjs` checks `process.execve` on the current Node; CI runs it.

| # | What it checks | If it fails |
|---|---|---|
| 1 | Account b continues a's conversation (`-c` in the same folder, `-r <id>` from another), `/rewind` offers a's checkpoints, and the task list carries over | **go/no-go**: find which entry must also be shared |
| 2 | Nothing loads twice under `$HOME` (`/context` from outside, under and at `$HOME`) | decide: accept it, or stop linking `rules` |
| 3 | A shared `sessions/`: one `claude agents --json` call sees every account, and a crash cleanup keeps other accounts' live entries | `shareSessions` off, `agentsPerAccount` on |
| 4 | Every account's prompts land in `~/.claude/history.jsonl`, locked at the store's path | `shareHistory` off |
| 5 | A shared `skills/` with two orgs: no churn in `synced/` or `.trash`, local skills untouched (`--with 5`) | `shareSkills` off |
| 6 | Linking all of `projects/`: `--continue`, `/resume`, `/stats`, and reopening a saved large tool output | **go/no-go** |
| 7 | `--chrome` in two accounts at once (`--with 7`, in the real home after a backup) | `shareChrome` off |
| 8 | macOS: one Keychain entry per account, and logging one out leaves the other logged in | **go/no-go** on macOS |
| 9 | `process.execve`; on macOS also the picker, terminal keys, completion and tmux, by hand | `spawnFallback` on |
| 11 | `/ide` in an account session finds an editor that runs as plain `claude` (`--with 11`, in the real home) | `linkIde` on |
| 12 | Claude Code's storage backend isn't active | **go/no-go**: adapt the share table and the merges |
| 13 | Plugins installed from a load in b after a's folder is gone, and b reopens a's saved large output through the links `rm` keeps | plugins: `normalizePaths` on; outputs: stop and decide |
| 14 | Logging out one login leaves the same user's other logins working (`--with 14`) | `keepSameEmailLogin` on |

Spike 10 (links survive daily use) has no run of its own: each launch repairs a link Claude Code replaced, and `xclaude doctor` reports one.

Nothing here is shipped: `package.json` publishes only `dist/`, `README.md` and `LICENSE`.
