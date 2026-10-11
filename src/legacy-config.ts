// Xanima 0.1.x compatibility with openwave (the plugin's previous name).
//
//   • Plugin id is now `xanima` (manifest legacyPluginIds: ["openwave"]).
//   • Config lives at plugins.entries.xanima.config. If that is empty and the
//     old plugins.entries.openwave.config exists, the old block is used as-is
//     and a one-time deprecation warning says how to upgrade.
//   • $XANIMA_BRAIN_TOKEN replaces $OPENWAVE_BRAIN_TOKEN (old name still read,
//     with a warning). The old names are dropped in 0.3.0 (kept through 0.2.x: neither release has shipped to a live install yet).
//   • upgradeOpenwaveConfig(): a pure transform of an openclaw.json object used
//     by the `xanima-openclaw-upgrade` CLI. It COPIES the openwave block to
//     xanima, disables (does not delete) the openwave entry so the two never
//     both register brain_* tools, and mirrors allow/deny lists. Rollback is
//     re-enabling openwave and disabling xanima (or restoring the backup file).

import { MANIFEST_CONFIG_DEFAULTS } from "./manifest-defaults.js";

export const PLUGIN_ID = "xanima";
export const LEGACY_PLUGIN_ID = "openwave";

const warned = new Set<string>();
export function resetLegacyWarnings(): void { warned.clear(); }
export function warnOnce(key: string, warn: (m: string) => void, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(`[xanima] DEPRECATED: ${msg}`);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Keys that are just host plumbing, not real plugin settings. */
function hasSettings(raw: Obj): boolean {
  const inner = isObj(raw["config"]) ? (raw["config"] as Obj) : raw;
  return Object.entries(inner).some(([k, v]) =>
    k !== "enabled" && k !== "hooks" &&
    !(k in MANIFEST_CONFIG_DEFAULTS && JSON.stringify(v) === JSON.stringify(MANIFEST_CONFIG_DEFAULTS[k])));
}

export type PluginConfigSource = "xanima" | "openwave-legacy" | "default";

/**
 * Pick the effective raw plugin config. `raw` is api.pluginConfig (the xanima
 * entry); `ocConfig` is the live OpenClaw config (to find a legacy entry).
 */
export function resolvePluginConfig(raw: Obj | undefined, ocConfig: unknown, warn: (m: string) => void): { raw: Obj; source: PluginConfigSource } {
  const mine = raw ?? {};
  // OpenClaw fills api.pluginConfig with the manifest's schema defaults, so it
  // is never "empty"; judge what the user actually set from the raw config file.
  // Values equal to the manifest defaults therefore do not count as settings.
  if (hasSettings(mine)) {
    const legacy = legacyEntry(ocConfig);
    if (legacy && legacy.enabled !== false) {
      warnOnce("both-enabled", warn, `both plugins.entries.xanima and plugins.entries.openwave are configured and openwave is not disabled — run xanima-openclaw-upgrade or set plugins.entries.openwave.enabled=false so only one registers the brain_* tools.`);
    }
    return { raw: mine, source: "xanima" };
  }
  const legacy = legacyEntry(ocConfig);
  if (legacy && isObj(legacy["config"]) && hasSettings(legacy)) {
    warnOnce("legacy-config", warn, `reading settings from plugins.entries.openwave.config (the old plugin name). Run xanima-openclaw-upgrade (or copy the block to plugins.entries.xanima.config); the openwave entry stops being read in 0.3.0.`);
    return { raw: { ...mine, config: legacy["config"] }, source: "openwave-legacy" };
  }
  return { raw: mine, source: "default" };
}

function legacyEntry(ocConfig: unknown): Obj | null {
  return entryFor(ocConfig, LEGACY_PLUGIN_ID);
}

function entryFor(ocConfig: unknown, id: string): Obj | null {
  if (!isObj(ocConfig)) return null;
  const plugins = ocConfig["plugins"];
  if (!isObj(plugins)) return null;
  const entries = plugins["entries"];
  if (!isObj(entries)) return null;
  const e = entries[id];
  return isObj(e) ? e : null;
}

/** $XANIMA_BRAIN_TOKEN, falling back to $OPENWAVE_BRAIN_TOKEN (deprecated). */
export function brainTokenFromEnv(env: NodeJS.ProcessEnv, warn: (m: string) => void = () => {}): string | undefined {
  const v = env["XANIMA_BRAIN_TOKEN"]?.trim();
  if (v) return v;
  const old = env["OPENWAVE_BRAIN_TOKEN"]?.trim();
  if (old) {
    warnOnce("env-token", warn, "$OPENWAVE_BRAIN_TOKEN is deprecated; set $XANIMA_BRAIN_TOKEN instead (the old name stops working in 0.3.0).");
    return old;
  }
  return undefined;
}

export interface UpgradeResult {
  changed: boolean;
  config: Obj;
  notes: string[];
}

/**
 * openwave 0.2.x → xanima 0.1.0 config upgrade (pure; the caller writes the
 * file after backing it up). Idempotent.
 */
export function upgradeOpenwaveConfig(input: Obj, opts: { rewriteDataPaths?: (oldPath: string) => string | null } = {}): UpgradeResult {
  const cfg = structuredClone(input) as Obj;
  const notes: string[] = [];
  const plugins = (isObj(cfg["plugins"]) ? cfg["plugins"] : (cfg["plugins"] = {})) as Obj;
  const entries = (isObj(plugins["entries"]) ? plugins["entries"] : (plugins["entries"] = {})) as Obj;
  const old = isObj(entries[LEGACY_PLUGIN_ID]) ? (entries[LEGACY_PLUGIN_ID] as Obj) : null;
  const cur = isObj(entries[PLUGIN_ID]) ? (entries[PLUGIN_ID] as Obj) : null;
  let changed = false;

  if (!old) {
    notes.push("no plugins.entries.openwave block — nothing to migrate");
  } else if (cur && hasSettings(cur)) {
    notes.push("plugins.entries.xanima already has settings — left as is (not overwritten)");
  } else {
    const next: Obj = { ...(cur ?? {}) };
    next["enabled"] = old["enabled"] !== false;
    if (isObj(old["config"])) next["config"] = structuredClone(old["config"]);
    if (isObj(old["hooks"])) next["hooks"] = structuredClone(old["hooks"]);
    entries[PLUGIN_ID] = next;
    notes.push(`copied plugins.entries.openwave → plugins.entries.xanima (${Object.keys(isObj(old["config"]) ? old["config"] as Obj : {}).length} config keys)`);
    changed = true;
  }
  if (old && old["enabled"] !== false) {
    old["enabled"] = false;
    notes.push("disabled plugins.entries.openwave (kept for rollback; re-enable it and disable xanima to roll back)");
    changed = true;
  }
  // Optional: point token/data paths in the xanima block at ~/.xanima once
  // `xanima-server migrate` has copied them (the caller decides per path).
  const xe = entries[PLUGIN_ID];
  if (opts.rewriteDataPaths && isObj(xe) && isObj(xe["config"])) {
    const conf = xe["config"] as Obj;
    for (const [k, v] of Object.entries(conf)) {
      if (typeof v !== "string" || !/[\\/]\.sharpwave([\\/]|$)/.test(v)) continue;
      const next = opts.rewriteDataPaths(v);
      if (next && next !== v) { conf[k] = next; notes.push(`plugins.entries.xanima.config.${k}: ${v} → ${next}`); changed = true; }
      else notes.push(`plugins.entries.xanima.config.${k} still points at ${v} (target under .xanima not found; run xanima-server migrate first)`);
    }
  }
  for (const listKey of ["allow", "deny"] as const) {
    const list = plugins[listKey];
    if (Array.isArray(list) && list.includes(LEGACY_PLUGIN_ID) && !list.includes(PLUGIN_ID)) {
      list.push(PLUGIN_ID);
      notes.push(`added "xanima" to plugins.${listKey} (kept "openwave")`);
      changed = true;
    }
  }
  return { changed, config: cfg, notes };
}
