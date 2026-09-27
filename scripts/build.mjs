// Bundles src/cli.ts into dist/xclaude.js: one ESM file, no runtime dependencies.
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const outfile = "dist/xclaude.js";
const pkgPath = resolve("package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));

// Only the version is needed at runtime; don't bundle the rest of package.json.
const versionOnly = {
  name: "version-only",
  setup(b) {
    b.onLoad({ filter: /[\\/]package\.json$/ }, (args) =>
      args.path === pkgPath ? { contents: JSON.stringify({ version }), loader: "json" } : undefined,
    );
  },
};

await build({
  entryPoints: ["src/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
  plugins: [versionOnly],
});

chmodSync(outfile, 0o755);
