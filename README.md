# xclaude

Run [Claude Code](https://code.claude.com) under several claude.ai logins, such as a personal one and one per organization seat, even at the same time in different terminals. Conversations, prompt history, memory and personal content (skills, agents, commands, plugins…) are shared by every login, so you can continue a conversation under another account.

```sh
xclaude add acme                   # new account, log in with /login
xclaude acme -c --chrome           # Claude Code on acme, flags passed through
xclaude                            # pick an account, then Claude Code
xclaude acme auth status           # any claude subcommand, run as acme
xclaude tmux new api acme -c       # tmux session "api" running Claude on acme
xclaude tmux attach api            # back to it later
```

## Install

Needs macOS or Linux (WSL counts), Node 22.15 or later, and [Claude Code](https://code.claude.com/docs/en/setup). `xclaude tmux` needs tmux 3.0 or later.

```sh
npm i -g xclaude-cli
xclaude add personal               # then log in with /login
xclaude shell install              # completion in ~/.zshrc and/or ~/.bashrc
```

Update with `npm i -g xclaude-cli@latest`; xclaude checks npm once a day and prints a one-line note when there's a newer version (`XCLAUDE_NO_UPDATE_CHECK=1` turns that off). Update Claude Code with `claude update` (or `xclaude <any> update`).

## Commands

| Command | What it does |
|---|---|
| `xclaude <account> [claude args…]` | Claude Code as that account; every argument goes to `claude` |
| `xclaude [claude flags…]` | the same, after picking the account (↑/↓, 1–9, Enter; Esc cancels) |
| `xclaude add <name> [--model M] [--effort E] [--args "…"] [--inherit on\|off]` | add an account, then log in with `/login`; first it asks whether the account takes `~/.claude`'s setup (`--inherit` answers up front) |
| `xclaude set <name> [--model M] [--effort E] [--args "…"] [--unset model\|effort\|args] [--inherit on\|off\|reset]` | change an account's defaults; with no options, show them. `--inherit on\|off` changes whether it takes `~/.claude`'s setup |
| `xclaude set main --enable\|--disable` | use the login in `~/.claude` (plain `claude`'s) as the account `main` |
| `xclaude ls` | accounts with their login, defaults and config dir |
| `xclaude rm <name> [--keep-login] [-y]` | remove an account and log it out; its folder keeps its links, so its old conversations still open their saved long outputs, and files of its own, such as a `CLAUDE.md` you edited with `/memory`. Run it on the name again to delete that folder (only once it holds nothing but links) |
| `xclaude rm --leftovers [-y]` | delete the leftover folders of all removed accounts, after a confirmation |
| `xclaude tmux new\|attach\|ls\|kill` | Claude Code in tmux sessions, by label |
| `xclaude shell install\|uninstall [--bash] [--zsh]` | completion (and the guard) in your shell |
| `xclaude shell completion bash\|zsh` | print the completion script, to load it some other way |
| `xclaude guard on\|off\|status` | make bare `claude` refuse to run in your shells |
| `xclaude doctor [--fix]` | check links, logins and setup; `--fix` repairs |
| `xclaude help [command]`, `-h`, `-v` | help for a command; `-v` prints the version |

Defaults are added before your arguments, and what you type wins: `xclaude acme --model sonnet` uses sonnet even if acme defaults to opus. `--effort` takes `low`, `medium`, `high`, `xhigh`, `max` or `ultracode`. Log in again any time with `xclaude <account> auth login`, or `/login` inside a session.

## tmux

```sh
xclaude tmux new api acme -c            # session "api": Claude on acme, attached
xclaude tmux new web --dir ~/code/web --detach beta
xclaude tmux new notes --empty          # just a shell
xclaude tmux ls                         # LABEL ACCOUNT WORKDIR ATTACHED CREATED CLAUDE
xclaude tmux attach                     # pick a session
xclaude tmux kill api
```

xclaude's options (`--dir`, `--detach`, `--empty`) come right after the label, and Claude's go after the account. Quitting Claude leaves a shell in the session; up-arrow reruns it. The `CLAUDE` column shows whether Claude is working, idle or needs input. The session's status bar shows the account (turn that off with `"tmux": { "statusRight": false }` in the config).

## Shell setup and the guard

`xclaude shell install` adds a small block to `~/.zshrc` (under `$ZDOTDIR` when set) and/or `~/.bashrc`, and on macOS to a `~/.bash_profile` that doesn't load `~/.bashrc`. It loads completion for commands, accounts, Claude's flags and values (models, effort, `--resume` sessions, paths) and tmux labels. `xclaude shell uninstall` removes it.

`xclaude guard on` makes bare `claude` print a reminder instead of running, so you don't start a session under the wrong login by habit. It still works inside Claude Code sessions, in anything xclaude starts, and whenever xclaude isn't installed.

## What's shared

- **Shared by all accounts:** conversations and their checkpoints (`projects`, `file-history`), prompt history, task lists, plans, running-session info, personal skills, agents, commands, rules, output styles, hooks and plugins, and `~/.claude/CLAUDE.md`.
- **Per account:** the login, `.claude.json` (MCP servers, folder trust), `settings.json` (so plugins and the statusline can differ per account), keybindings, background sessions and caches. The MCP servers you added to `~/.claude.json` with `claude mcp add --scope user` still reach every account that takes `~/.claude`'s setup: each launch passes them with `--mcp-config`, and an account's own server of the same name wins (`xclaude <name> mcp list` shows only its own).
- **Logins:** each account signs in with its own login. A claude.ai login in your shell (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and the variables that provision one) is left out of accounts: Claude Code would use it in place of every account's login, so one subscription ending would stop them all. `main` and plain `claude` still get it, and a token meant for one account can go in that account's `settings.json` `env`. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, a cloud provider (`CLAUDE_CODE_USE_BEDROCK`, `_VERTEX`, `_FOUNDRY`) and `ANTHROPIC_PROFILE` come before an account's login too; they're passed on, each account's launch says so once, and `xclaude ls` names the credential in use in place of the email.
- **Asked once:** an account's first launch in a terminal (or `xclaude add`) shows what `~/.claude` would give it (settings, the plugins `~/.claude` has on, MCP servers) and asks whether it takes them. The answer is kept; `xclaude set <name> --inherit on|off` changes it. A launch without a terminal takes nothing until then and says once how to choose.
- **Taken from `~/.claude/settings.json`:** once the answer is yes, at every launch the account's `settings.json` takes what changed in `~/.claude/settings.json` since the last time: permission rules, hooks, auto mode and the rest, apart from login-bound settings (`env`, `apiKeyHelper` and the other credential helpers, `forceLoginMethod`, `forceLoginOrgUUID`) and `enabledPlugins`. What the account changed itself stays, so a rule it added or removed stays that way, and one you remove from `~/.claude/settings.json` goes from the accounts too. `~/.claude/settings.json` itself is never written. `xclaude set <name> --inherit off` stops it and takes back what the account took and hasn't changed; `--inherit reset` takes everything again.
- **Plugins:** a plugin installed under another login shows in an account's `/plugin` from its next launch: on when `~/.claude` has it on (in an account that takes `~/.claude`'s setup), off otherwise. Until you change such an entry, it follows `~/.claude` turning the plugin on or off; once you do, it's yours. Uninstalling a plugin removes it for every login. For the `~/.claude` login, turn on a plugin an account installed with `claude plugin enable <plugin>`.

Sharing works by linking each account's directories into `~/.claude`, which plain `claude` keeps using as before. Don't open the same conversation in two terminals at once. Scripts can read `XCLAUDE_ACCOUNT` to show the account, for example in a statusline.

## Files

- `~/.xclaude/config.json` holds accounts, defaults and settings. Most of it is edited through the commands; by hand you can add `share.add` / `share.remove` (extra directories to share, or built-in ones to stop sharing), `claudePath` (a fixed `claude` binary) and `tmux.statusRight` ([docs/architecture.md](docs/architecture.md#2-layout) has the format). `~/.xclaude/accounts/<name>/` is each account's `CLAUDE_CONFIG_DIR` (`xclaude ls` prints it, e.g. for an editor's environment settings). `XCLAUDE_HOME` moves `~/.xclaude`; set it before adding accounts, since on macOS the login is tied to the exact directory path and moving it later means logging in again.
- `~/.claude` stays the shared store; nothing in it moves.

## Uninstall

```sh
xclaude rm <name>                  # for each account (logs it out)
xclaude shell uninstall
npm rm -g xclaude-cli
rm -rf ~/.xclaude
```

Your conversations stay in `~/.claude`.

More detail: [docs/architecture.md](docs/architecture.md).

## License

MIT
