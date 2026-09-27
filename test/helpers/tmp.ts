// Temp directories for in-process unit tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A fresh directory (its real path, so link targets compare equal on macOS). */
export function tempDir(prefix = "xclaude-unit-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Removes a temp dir, restoring permissions tests may have taken away. */
export function removeTemp(dir: string): void {
  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    fs.chmodSync(p, 0o700);
    for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Creates files from a { "rel/path": "content" } map; a value of { link } makes a symlink. */
export function writeTree(root: string, tree: Record<string, string | { link: string }>): void {
  for (const [rel, value] of Object.entries(tree)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (typeof value === "string") fs.writeFileSync(p, value);
    else fs.symlinkSync(value.link, p);
  }
}

/** Lists a tree as { "rel/path": content | "-> target" | "/" } for easy comparison. */
export function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) {
        out[`${rel}/`] = "/";
        walk(p, rel);
      } else out[rel] = fs.readFileSync(p, "utf8");
    }
  };
  walk(root, "");
  return out;
}
