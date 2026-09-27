// Splitting a string like a shell command line (for --args "…"), and quoting
// words for display or for typing into a shell (tmux send-keys).
import { UsageError } from "./errors.ts";

/**
 * Splits like sh: whitespace separates words; single quotes are literal; in
 * double quotes, backslash escapes " \ $ and `; elsewhere a backslash escapes the
 * next character. An unquoted ~ at the start of a word (alone or before /)
 * becomes the home directory. Nothing else is expanded.
 */
export function splitShellWords(input: string, home: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  const atWordStart = () => !inWord;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      i++;
      continue;
    }
    if (c === "~" && atWordStart() && (i + 1 === input.length || input[i + 1] === "/" || /\s/.test(input[i + 1]!))) {
      word += home;
      inWord = true;
      i++;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new UsageError("unterminated ' in --args");
      word += input.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= input.length) throw new UsageError('unterminated " in --args');
        const d = input[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
          word += input[i + 1];
          i += 2;
        } else {
          word += d;
          i++;
        }
      }
    } else if (c === "\\") {
      if (i + 1 < input.length) word += input[i + 1];
      i += 2;
    } else {
      word += c;
      i++;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** Quotes a word for sh, bash and zsh only when it needs it. */
export function quoteShellWord(word: string): string {
  // A leading = would be expanded by zsh (the EQUALS option), so it's quoted.
  if (word !== "" && !word.startsWith("=") && /^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function quoteShellWords(words: string[]): string {
  return words.map(quoteShellWord).join(" ");
}
