// Path normalization, exercised with the switch's code path on.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyNormalization, normalizePaths, planNormalization } from "../../src/link/normalize.ts";
import { type Home, makeHome } from "../helpers/accounts.ts";

let h: Home;
let acc: string;
let claude: string;
beforeEach(() => {
  h = makeHome("normalizePaths=1");
  h.account("acme");
  h.account("b");
  h.repair("acme");
  acc = path.join(h.paths.xhome, "accounts");
  claude = path.join(h.paths.home, ".claude");
});
afterEach(() => h.cleanup());

function writeRegistry(): { installed: string; markets: string } {
  const installed = path.join(h.S, "plugins", "installed_plugins.json");
  const markets = path.join(h.S, "plugins", "known_marketplaces.json");
  fs.writeFileSync(
    installed,
    `${JSON.stringify(
      {
        version: 2,
        plugins: {
          "foo@market": [{ scope: "user", installPath: `${acc}/acme/plugins/cache/market/foo/1.0.0`, version: "1.0.0" }],
          "bar@market": [{ scope: "user", installPath: `${acc}/b/plugins/cache/market/bar/2.0.0`, version: "2.0.0" }],
          "own@market": [{ scope: "user", installPath: `${claude}/plugins/cache/market/own/1.0.0` }],
        },
        note: `${acc}-other/acme/plugins`,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(markets, JSON.stringify({ market: { source: { source: "github", repo: "o/r" }, installLocation: `${acc}/acme/plugins/marketplaces/market` } }, null, 2));
  return { installed, markets };
}

describe("path normalization", () => {
  it("rewrites account-dir paths to ~/.claude and leaves everything else", () => {
    const { installed, markets } = writeRegistry();
    const res = normalizePaths(h.paths, { lockWaitMs: 1000, log: (l) => h.logs.push(l) });
    assert.equal(res.changed.length, 2);
    const inst = JSON.parse(fs.readFileSync(installed, "utf8"));
    assert.equal(inst.plugins["foo@market"][0].installPath, `${claude}/plugins/cache/market/foo/1.0.0`);
    assert.equal(inst.plugins["bar@market"][0].installPath, `${claude}/plugins/cache/market/bar/2.0.0`);
    assert.equal(inst.plugins["own@market"][0].installPath, `${claude}/plugins/cache/market/own/1.0.0`);
    assert.equal(inst.note, `${acc}-other/acme/plugins`, "a lookalike prefix is left alone");
    assert.ok(fs.readFileSync(installed, "utf8").endsWith("}\n"));
    assert.equal(JSON.parse(fs.readFileSync(markets, "utf8")).market.installLocation, `${claude}/plugins/marketplaces/market`);
    assert.ok(!fs.readFileSync(markets, "utf8").endsWith("\n"));
    assert.match(h.logs.join("\n"), /rewrote 2 account-dir paths in ~\/\.claude\/plugins\/installed_plugins\.json/);
    assert.equal(planNormalization(h.paths).length, 0, "a second run finds nothing");
  });

  it("limits itself to one account when asked (rm)", () => {
    const { installed } = writeRegistry();
    normalizePaths(h.paths, { account: "acme", lockWaitMs: 1000, log: () => {} });
    const inst = JSON.parse(fs.readFileSync(installed, "utf8"));
    assert.equal(inst.plugins["foo@market"][0].installPath, `${claude}/plugins/cache/market/foo/1.0.0`);
    assert.equal(inst.plugins["bar@market"][0].installPath, `${acc}/b/plugins/cache/market/bar/2.0.0`);
  });

  it("skips a file Claude Code wrote after it was read", () => {
    const { installed } = writeRegistry();
    const plans = planNormalization(h.paths);
    fs.appendFileSync(installed, " "); // Claude Code got there first
    const res = applyNormalization(plans);
    assert.deepEqual(res.skipped, [fs.realpathSync(installed)]);
    assert.match(fs.readFileSync(installed, "utf8"), new RegExp(`${acc}/acme/plugins/cache`));
  });

  it("ignores missing and unparsable files", () => {
    assert.deepEqual(planNormalization(h.paths), []);
    fs.writeFileSync(path.join(h.S, "plugins", "installed_plugins.json"), `{ "half": "${acc}/acme/`);
    assert.deepEqual(planNormalization(h.paths), []);
  });
});
