// Help texts (keep them in step with README.md).
import { UsageError } from "../core/errors.ts";

const MAIN_HELP = `xclaude — run Claude Code under several claude.ai logins at once

Usage:
  xclaude <account> [claude args…]   Claude Code as that account
  xclaude [claude flags…]            the same, after picking the account
  xclaude <command> [args…]          one of the commands below

Everything after the account goes to claude, flags and subcommands alike, as in
xclaude acme -c --chrome or xclaude acme auth status.

Commands:
  add <name>                  add an account, then log in with /login
  ls                          list accounts: login, defaults, config dir
  set <name>                  change an account's defaults
  set main --enable|--disable use the login in ~/.claude as the account "main"
  rm <name>                   remove an account and log it out
  rm --leftovers              delete the folders removed accounts left behind
  tmux new|attach|ls|kill     run Claude Code in tmux sessions, by label
  shell install|uninstall     completion (and the guard) in ~/.zshrc, ~/.bashrc
  shell completion bash|zsh   print the completion script to load elsewhere
  guard on|off|status         make bare \`claude\` refuse to run in your shells
  doctor [--fix]              check links, logins and setup; --fix repairs
  help [command]              a command's options; -v prints the version

Conversations, prompt history, memory and personal content (skills, agents,
commands, plugins…) are shared by every account, so \`xclaude other -c\`
continues the last conversation in this folder, whichever account it ran on.
`;

const COMMAND_HELP: Record<string, string> = {
  add: `Usage: xclaude add <name> [--model M] [--effort E] [--args "…"]

Creates the account, links it to the shared ~/.claude, then starts Claude Code
in it so you can go through the first-run screens and log in with /login.

  --model M     default model, e.g. opus or sonnet
  --effort E    default effort: low, medium, high, xhigh, max or ultracode
  --args "…"    extra Claude Code arguments for every launch, split like a
                shell line

Names use lowercase letters, digits and dashes, and start with a letter.
`,
  rm: `Usage: xclaude rm <name> [--keep-login] [-y]
       xclaude rm --leftovers [-y]

Removes an account: stops its background sessions, logs it out, and deletes its
login, settings and caches. Shared conversations and content stay in ~/.claude.

Its folder keeps only its links into ~/.claude, so its old conversations can
still open their saved long outputs. Run rm on the name again to delete that
leftover folder, or --leftovers to delete every one, after a confirmation.

  --keep-login  don't log the account out
  --leftovers   delete the leftover folders of all removed accounts
  -y            don't ask for confirmation
`,
  ls: `Usage: xclaude ls

Lists the accounts with their email, organization and login status, their
defaults, and each one's config dir (the CLAUDE_CONFIG_DIR to use elsewhere,
e.g. in an editor's environment settings).
`,
  set: `Usage: xclaude set <name> [--model M] [--effort E] [--args "…"]
                   [--unset model|effort|args]
       xclaude set main --enable|--disable

Changes an account's launch defaults; with no options, prints them.
Arguments typed at launch always win over these defaults.

  --model M      default model
  --effort E     default effort: low, medium, high, xhigh, max or ultracode
  --args "…"     extra Claude Code arguments, split like a shell line
  --unset KEY    clear model, effort or args
  --enable       (main only) use the login in ~/.claude as the account "main"
  --disable      (main only) turn it off again
`,
  tmux: `Usage: xclaude tmux new <label> [--dir <path>] [--detach] [--empty]
                        [<account> [claude args…]]
       xclaude tmux attach [<label>]
       xclaude tmux ls
       xclaude tmux kill <label>

  new       create session <label> running Claude Code on <account> (the picker
            opens without one), then attach to it
              --dir <path>  working directory (default: the current one)
              --detach      don't attach
              --empty       just a shell, no Claude Code
  attach    attach to a session; without a label, pick one
  ls        list sessions with their account, directory and Claude's state
  kill      end a session

Bare \`xclaude tmux\` is \`xclaude tmux ls\`. Needs tmux 3.0 or later.
`,
  shell: `Usage: xclaude shell install|uninstall [--bash] [--zsh]
       xclaude shell completion bash|zsh

  install      add a small block to ~/.zshrc (under $ZDOTDIR when set) and/or
               ~/.bashrc, whichever exist, that loads completion and, when on,
               the guard; on macOS also to a ~/.bash_profile that doesn't load
               ~/.bashrc
  uninstall    remove that block
  completion   print the completion script for a shell

Open a new shell (or run \`exec $SHELL\`) afterwards.
`,
  guard: `Usage: xclaude guard on|off|status

When on, bare \`claude\` refuses to run in interactive shells and points to
xclaude. It still works inside Claude Code sessions, in anything xclaude
started, and whenever xclaude isn't installed. Needs \`xclaude shell install\`.
`,
  doctor: `Usage: xclaude doctor [--fix]

Checks tools, config, every account's links and login, the shell setup,
machine-managed settings and the environment. Exits non-zero if something is
wrong.

  --fix    repair links, merge left-behind directories, fix CLAUDE.md stubs
`,
  help: `Usage: xclaude help [command]
`,
};

export function helpText(topic?: string): string {
  if (topic === undefined) return MAIN_HELP;
  const text = COMMAND_HELP[topic];
  if (!text) throw new UsageError(`no help for "${topic}"; commands: ${Object.keys(COMMAND_HELP).join(", ")}`);
  return text;
}

export function wantsHelp(args: string[]): boolean {
  return args[0] === "-h" || args[0] === "--help";
}
