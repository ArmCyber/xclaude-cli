# Changelog

## Unreleased

- Accounts save Claude's auto memory straight into `~/.claude`, the folder plain `claude` uses, so saving a memory no longer asks for permission, in auto mode or any other. From Claude Code 2.1.280 on, a save through an account's link into `~/.claude` waited for a person's yes. Plan mode in an account still asks before it saves a plan file.

## 0.2.1 (2026-10-20)

- Accounts no longer get a claude.ai login from the shell (`CLAUDE_CODE_OAUTH_TOKEN` and the variables that provision one). Claude Code used it in place of every account's own login, so one ended subscription stopped them all. `main` still gets it.
- A launch says once per account what it left out, and when `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, a cloud provider or `ANTHROPIC_PROFILE` may stand in for the account's login. `doctor` lists them under Environment.
- `ls`, `doctor` and `add` name the credential in use when it isn't a claude.ai login, and `add` no longer reports such accounts as sharing a login.

## 0.2.0 (2026-10-19)

- Accounts can take what `~/.claude/settings.json` sets, at every launch, keeping their own changes. `env`, credential helpers and forced-login settings stay per account, and `~/.claude/settings.json` is never written.
- Accounts that take it also get the plugins `~/.claude` has on and the MCP servers in `~/.claude.json` (passed with `--mcp-config`).
- An account's first launch in a terminal, or `add`, asks once whether it takes this. `add --inherit on|off` answers up front; `set <name> --inherit on|off|reset` changes it.
- `rm` keeps an account's own `CLAUDE.md` and files xclaude doesn't know.
- Knows Claude Code's new `remote-control` entry.

## 0.1.4 (2026-10-12)

- Plugins installed under another login show in each account's `/plugin`, turned off.

## 0.1.3 (2026-10-12)

- A daily update check: a one-line note when npm has a newer xclaude (`XCLAUDE_NO_UPDATE_CHECK=1` turns it off).

## 0.1.2 (2026-09-27)

- The first version in this repository: accounts (`add`, `set`, `ls`, `rm`, and `main` for the `~/.claude` login), conversations, history, memory and personal content shared through links into `~/.claude`, the account picker, `tmux` sessions, shell completion and the guard, and `doctor`.
