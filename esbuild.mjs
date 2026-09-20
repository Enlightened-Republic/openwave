import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Single-file plugin bundle. `sharpwave-core` (the engine) is inlined so the
// gateway loads one file; only the native modules and node:* stay external.
await build({
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "sqlite-vec-darwin-arm64",
    "sqlite-vec-darwin-x64",
    "sqlite-vec-linux-x64",
    "sqlite-vec-windows-x64",
    "node:*",
  ],
  banner: { js: `// openwave — built ${new Date().toISOString()}\n` },
});

console.log("openwave built to dist/index.js");

// Native Control UI bundle (the persona settings page).
//
// We build this ourselves and declare it in openclaw.plugin.json.controlUi,
// which is the documented "prebuilt browser bundle" path
// (docs/plugins/feature-plugins.md, "Build and reload"). Do NOT set
// package.json.openclaw.controlUi and do NOT run `openclaw plugins build`:
// that command is the tool-plugin authoring generator. It requires an entry made
// with defineToolPlugin (getToolPluginMetadata reads a symbol only that helper
// sets) and it regenerates this manifest and package.json from that metadata,
// which would overwrite the hand-written configSchema. openwave's entry is a
// classic plugin entry, so the command can never succeed here.
//
// The output is content-hashed (dist/control-ui/<hash>/index.js), so it is
// deterministic: no timestamp banner, unlike the backend bundle above.
const MAX_ASSET_BYTES = 4 * 1024 * 1024; // per-asset limit from feature-plugins.md

const ui = await build({
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  entryPoints: { index: "src/control-ui.ts" },
  outdir: "dist/control-ui",
  write: false,
  legalComments: "none",
});

const files = ui.outputFiles.map((f) => ({ ext: f.path.split(".").pop(), bytes: f.contents }));
const js = files.find((f) => f.ext === "js");
const css = files.find((f) => f.ext === "css");
if (!js) throw new Error("control-ui build produced no JavaScript output");
for (const f of files) {
  if (f.bytes.length > MAX_ASSET_BYTES) throw new Error(`control-ui .${f.ext} is ${f.bytes.length} bytes; limit is ${MAX_ASSET_BYTES}`);
}

const hash = createHash("sha256");
for (const f of files) hash.update(f.ext).update(f.bytes);
const contentHash = hash.digest("hex").slice(0, 16);

const outDir = `dist/control-ui/${contentHash}`;
rmSync("dist/control-ui", { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/index.js`, js.bytes);
if (css) writeFileSync(`${outDir}/index.css`, css.bytes);

const manifestPath = "openclaw.plugin.json";
const rawManifest = readFileSync(manifestPath, "utf8");
const eol = rawManifest.includes("\r\n") ? "\r\n" : "\n";
const manifest = JSON.parse(rawManifest);
manifest.controlUi = {
  entry: `dist/control-ui/${contentHash}/index.js`,
  ...(css ? { styles: [`dist/control-ui/${contentHash}/index.css`] } : {}),
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2).replace(/\n/g, eol) + eol);

console.log(`openwave control UI built to ${outDir}/ (${js.bytes.length} bytes js${css ? `, ${css.bytes.length} bytes css` : ""})`);
