import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOptions } from "../../src/core/options.ts";
import { quoteShellWord, quoteShellWords, splitShellWords } from "../../src/core/shellwords.ts";

describe("parseOptions", () => {
  const defs = { model: { value: true }, unset: { value: true, repeat: true }, yes: { short: "y" }, fix: {} };

  it("reads values in both spellings, flags, shorts and positionals", () => {
    const p = parseOptions(["acme", "--model", "opus", "--unset=args", "--unset", "effort", "-y", "--fix"], defs, "set");
    assert.deepEqual(p.positionals, ["acme"]);
    assert.deepEqual(p.values, { model: "opus", unset: ["args", "effort"], yes: true, fix: true });
    assert.deepEqual(parseOptions(["--model=a=b"], defs, "x").values, { model: "a=b" });
    assert.deepEqual(parseOptions(["--", "--model"], defs, "x").positionals, ["--model"]);
  });

  it("rejects unknown options, missing values and stray values", () => {
    assert.throws(() => parseOptions(["--nope"], defs, "set"), /set: unknown option --nope/);
    assert.throws(() => parseOptions(["-x"], defs, "set"), /unknown option -x/);
    assert.throws(() => parseOptions(["--model"], defs, "set"), /--model needs a value/);
    assert.throws(() => parseOptions(["--fix=1"], defs, "doctor"), /--fix doesn't take a value/);
  });
});

describe("shell words", () => {
  it("splits like sh", () => {
    assert.deepEqual(splitShellWords(`--add-dir "/a b" '/c d' e\\ f --chrome`, "/h"), ["--add-dir", "/a b", "/c d", "e f", "--chrome"]);
    assert.deepEqual(splitShellWords(`  x  `, "/h"), ["x"]);
    assert.deepEqual(splitShellWords(``, "/h"), []);
    assert.deepEqual(splitShellWords(`"" ''`, "/h"), ["", ""]);
    assert.deepEqual(splitShellWords(`"a \\"q\\" \\$x \\n"`, "/h"), [`a "q" $x \\n`]);
    assert.deepEqual(splitShellWords(`'it'"'"'s'`, "/h"), ["it's"]);
  });

  it("expands a leading unquoted ~ only", () => {
    assert.deepEqual(splitShellWords(`~ ~/x a~/y '~/z' "~/w" ~user`, "/h"), ["/h", "/h/x", "a~/y", "~/z", "~/w", "~user"]);
  });

  it("rejects unterminated quotes", () => {
    assert.throws(() => splitShellWords(`"abc`, "/h"), /unterminated "/);
    assert.throws(() => splitShellWords(`'abc`, "/h"), /unterminated '/);
  });

  it("quotes only when needed, and round-trips", () => {
    assert.equal(quoteShellWord("--add-dir=/a/b"), "--add-dir=/a/b");
    assert.equal(quoteShellWord("two words"), "'two words'");
    assert.equal(quoteShellWord(""), "''");
    assert.equal(quoteShellWord("it's"), `'it'\\''s'`);
    assert.equal(quoteShellWord("=foo"), "'=foo'", "zsh expands a leading =");
    assert.equal(quoteShellWord("a=b"), "a=b");
    const words = ["-p", "it's \"x\" $HOME", "a;b", "", "--model=opus", "*", "~/x"];
    assert.deepEqual(splitShellWords(quoteShellWords(words), "/h"), words);
  });
});
