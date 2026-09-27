import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runtimeProblem } from "../src/runtime.ts";

describe("runtime check", () => {
  it("accepts Node 22.15 and later on macOS and Linux", () => {
    for (const v of ["22.15.0", "22.20.1", "23.0.0", "24.19.0", "26.1.0"]) {
      assert.equal(runtimeProblem("linux", v), null, v);
      assert.equal(runtimeProblem("darwin", v), null, v);
    }
  });

  it("rejects older Node and other platforms", () => {
    assert.equal(runtimeProblem("linux", "22.14.0"), "Node 22.15 or later is required (this is 22.14.0)");
    assert.match(runtimeProblem("linux", "20.18.0")!, /Node 22\.15 or later/);
    assert.equal(runtimeProblem("win32", "24.0.0"), "win32 isn't supported; xclaude runs on macOS and Linux (including WSL)");
  });
});
