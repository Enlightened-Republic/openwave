import { build } from "esbuild";

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
