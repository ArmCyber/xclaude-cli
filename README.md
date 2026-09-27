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

Update with `npm i -g xclaude-cli@latest`. Update Claude Code with `claude update` (or `xclaude <any> update`).

## Commands

| Command | What it does |
|---|---|
| `xclaude <account> [claude args…]` | Claude Code as that account; every argument goes to `claude` |
| `xclaude [claude flags…]` | the same, after picking the account (↑/↓, 1–9, Enter; Esc cancels) |
| `xclaude add <name> [--model M] [--effort E] [--args "…"]` | add an account, then log in with `/login` |
| `xclaude set <name> [--model M] [--effort E] [--args "…"] [--unset model\|effort\|args]` | change an account's defaults; with no options, show them |
| `xclaude set main --enable\|--disable` | use the login in `~/.claude` (plain `claude`'s) as the account `main` |
| `xclaude ls` | accounts with their login, defaults and config dir |
| `xclaude rm <name> [--keep-login] [-y]` | remove an account and log it out; its folder keeps only its links, so its old conversations still open their saved long outputs. Run it on the name again to delete that folder (only while it holds nothing but links) |
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
- **Per account:** the login, `.claude.json` (MCP servers, folder trust), `settings.json` (so plugins, hooks and the statusline are enabled per account), keybindings, background sessions and caches.

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
