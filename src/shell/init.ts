// The generated init files: thin completion shims that ask
// `xclaude __complete`, plus the guard when it's on. Sourcing a file costs
// nothing at shell startup; Node only runs when you press TAB.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../core/config.ts";
import { writeFileAtomic } from "../core/fsutil.ts";
import { mkdirPrivate, type Paths } from "../core/paths.ts";
import type { Shell } from "./rc.ts";

function header(shell: Shell, version: string): string {
  return `# xclaude ${version}: ${shell} integration. Written by \`xclaude shell install\`, \`xclaude guard on|off\`
# and after xclaude updates; don't edit, changes are overwritten.
`;
}

/** The guard: the same function in bash and zsh. */
export const GUARD = `unalias claude 2>/dev/null
claude() {
  if [ -n "$XCLAUDE_ACCOUNT" ] || [ -n "$CLAUDE_CODE_CHILD_SESSION" ] || ! command -v xclaude >/dev/null 2>&1; then
    command claude "$@"
  else
    echo "claude is disabled — use: xclaude <account>   (accounts: $(xclaude __names 2>/dev/null))" >&2
    return 1
  fi
}
`;

/**
 * bash 3.2 (macOS /bin/bash): no compopt, mapfile or associative arrays.
 * Registered with -o nospace; the function adds trailing spaces itself.
 * COMP_WORDBREAKS splits --flag=value into --flag, =, value; __complete joins
 * them back and answers with just the value part, which is what readline
 * replaces.
 */
export function initBash(version: string, guard: boolean): string {
  return `${header("bash", version)}command -v xclaude >/dev/null 2>&1 || return 0

_xclaude_complete() {
  local cur out directive rest line q p
  cur=\${COMP_WORDS[COMP_CWORD]}
  [ "$cur" = "=" ] && cur=
  # bash 3.2 keeps --flag=value in one word; readline completes the part after =.
  case $cur in -*=*) cur=\${cur#*=} ;; esac
  out=$(xclaude __complete bash "$COMP_CWORD" "\${COMP_WORDS[@]}" 2>/dev/null) || return 0
  directive=\${out%%$'\\n'*}
  case $out in
    *$'\\n'*) rest=\${out#*$'\\n'} ;;
    *) rest= ;;
  esac
  COMPREPLY=()
  case $directive in
    files|dirs)
      if [ "$directive" = dirs ]; then rest=$(compgen -d -- "$cur"); else rest=$(compgen -f -- "$cur"); fi
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        printf -v q '%q' "$line"
        case $q in '\\~'*) q=\${q#\\\\} ;; esac
        p=$line
        case $p in '~/'*) p=$HOME/\${p#'~/'} ;; esac
        if [ -d "$p" ]; then COMPREPLY[\${#COMPREPLY[@]}]="$q/"; else COMPREPLY[\${#COMPREPLY[@]}]="$q "; fi
      done <<XCLAUDE_EOF
$rest
XCLAUDE_EOF
      ;;
    *)
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        if [ "$directive" = nospace ]; then COMPREPLY[\${#COMPREPLY[@]}]="$line"; else COMPREPLY[\${#COMPREPLY[@]}]="$line "; fi
      done <<XCLAUDE_EOF
$rest
XCLAUDE_EOF
      ;;
  esac
  return 0
}
complete -o nospace -F _xclaude_complete xclaude
${guard ? `\n${GUARD}` : ""}`;
}

/**
 * zsh: registered from a precmd hook that runs once, at the first prompt, and
 * then removes itself. By then the rest of the rc files have run, including any
 * later compinit, which would wipe a compdef made earlier.
 */
export function initZsh(version: string, guard: boolean): string {
  return `${header("zsh", version)}command -v xclaude >/dev/null 2>&1 || return 0

_xclaude_complete() {
  local out directive line
  local -a lines vals descs
  out=$(xclaude __complete zsh $(( CURRENT - 1 )) "\${words[@]}" 2>/dev/null) || return 1
  lines=("\${(@f)out}")
  directive=\${lines[1]}
  shift lines
  case $directive in
    files) compset -P '*='; _files ;;
    dirs) compset -P '*='; _files -/ ;;
    *)
      for line in "\${lines[@]}"; do
        [[ -n $line ]] || continue
        vals+=("\${line%%$'\\t'*}")
        if [[ $line == *$'\\t'* ]]; then
          descs+=("\${line%%$'\\t'*}  -- \${line#*$'\\t'}")
        else
          descs+=("$line")
        fi
      done
      (( \${#vals} )) || return 1
      if [[ $directive == nospace ]]; then
        compadd -S '' -l -d descs -a vals
      else
        compadd -l -d descs -a vals
      fi
      ;;
  esac
}

_xclaude_register() {
  add-zsh-hook -d precmd _xclaude_register
  (( $+functions[compdef] )) || { autoload -Uz compinit && compinit -i; }
  compdef _xclaude_complete xclaude
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _xclaude_register
${guard ? `\n${GUARD}` : ""}`;
}

export function initFile(paths: Paths, shell: Shell): string {
  return path.join(paths.shell, `init.${shell}`);
}

/** Writes both init files; they're tiny, so both are always kept current. */
export function writeInitFiles(paths: Paths, config: Config, version: string): void {
  mkdirPrivate(paths.shell);
  writeFileAtomic(initFile(paths, "bash"), initBash(version, config.guard), { mode: 0o644 });
  writeFileAtomic(initFile(paths, "zsh"), initZsh(version, config.guard), { mode: 0o644 });
}

/** On the first run after an update, regenerate the init files (if shell integration is set up). */
export function refreshInitFiles(paths: Paths, config: Config, version: string): void {
  if (fs.existsSync(paths.shell)) writeInitFiles(paths, config, version);
}
