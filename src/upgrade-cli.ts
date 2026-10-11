// xanima-openclaw-upgrade [--config <openclaw.json>] [--write]
//
// Upgrade an OpenClaw config from the openwave plugin (0.2.x) to xanima
// (0.1.0). Dry run by default: prints what would change. With --write it saves
// a timestamped backup next to the file first, then writes the new config.
// Stop the gateway first, or use `openclaw gateway restart` afterwards.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { upgradeOpenwaveConfig } from "./legacy-config.js";

function main(argv: string[]): number {
  let file = process.env["OPENCLAW_CONFIG_PATH"] ?? join(process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw"), "openclaw.json");
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") file = argv[++i] ?? file;
    else if (a === "--write") write = true;
    else if (a === "-h" || a === "--help") {
      process.stdout.write("usage: xanima-openclaw-upgrade [--config <openclaw.json>] [--write]\n");
      return 0;
    } else { process.stderr.write(`unknown argument ${a}\n`); return 2; }
  }
  if (!existsSync(file)) { process.stderr.write(`no OpenClaw config at ${file}\n`); return 2; }
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  let json: Record<string, unknown>;
  try { json = JSON.parse(raw); } catch {
    process.stderr.write(`${file} is not plain JSON (comments / JSON5?). Upgrade by hand: copy plugins.entries.openwave to plugins.entries.xanima and set plugins.entries.openwave.enabled=false.\n`);
    return 2;
  }
  const r = upgradeOpenwaveConfig(json);
  for (const n of r.notes) process.stdout.write(`- ${n}\n`);
  if (!r.changed) { process.stdout.write("nothing to change\n"); return 0; }
  if (!write) { process.stdout.write("dry run: re-run with --write to apply (a backup is made first)\n"); return 0; }
  const backup = `${file}.pre-xanima-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  copyFileSync(file, backup);
  writeFileSync(file, JSON.stringify(r.config, null, 2) + "\n");
  process.stdout.write(`written ${file}\nbackup  ${backup}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
