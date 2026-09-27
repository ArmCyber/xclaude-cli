// The spike suite's teardown must never reach the owner's own tmux server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { Suite } from "../spikes/lib.ts";
import { removeTemp, tempDir } from "./helpers/tmp.ts";

it("the spike suite stops only its scratch tmux server, even when setup never ran", () => {
  const bin = tempDir();
  try {
    const log = path.join(bin, "tmux.log");
    fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh\necho "TMUX_TMPDIR=$TMUX_TMPDIR $*" >> "${log}"\n`, { mode: 0o755 });
    const s = new Suite({ fake: true, only: null, with: [], keep: false, tarball: null, claude: null });
    s.env.PATH = `${bin}:/usr/bin:/bin`;
    s.cleanup();
    assert.equal(fs.readFileSync(log, "utf8"), `TMUX_TMPDIR=${s.tmuxTmp} kill-server\n`);
    assert.ok(!fs.existsSync(s.root) && !fs.existsSync(s.tmuxTmp), "the scratch folders are gone");
  } finally {
    removeTemp(bin);
  }
});
