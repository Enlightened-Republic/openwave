// Xanima 0.1.0 plugin: openwave → xanima compatibility (legacy config entry,
// legacy token env, config upgrade transform + CLI), recall labels, and the
// local-mode status footer.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "xanima-core";

import plugin from "../src/index.js";
import { resolvePluginConfig, upgradeOpenwaveConfig, brainTokenFromEnv, resetLegacyWarnings } from "../src/legacy-config.js";
import { loadToken } from "../src/remote/settings.js";
import { formatRecallBlock, RECALL_BLOCK_HEADER } from "../src/remote/register.js";
import { makeMockApi } from "./mock-api.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => resetLegacyWarnings());

const OPENWAVE_020 = {
  plugins: {
    allow: ["openwave", "telegram"],
    entries: {
      openwave: {
        enabled: true,
        config: { agents: "*", brainMode: "remote", brainUrl: "http://127.0.0.1:18790", brainTokenFile: "~/.sharpwave/tokens/{agentId}.token", autoProvision: true, provisionTokenFile: "~/.sharpwave/tokens/_provisioner.token", sharedRecall: true },
      },
      telegram: { enabled: true },
    },
  },
  agents: { list: [{ id: "main" }] },
};

describe("resolvePluginConfig", () => {
  test("xanima entry wins; empty xanima entry falls back to openwave with one warning", () => {
    const warns: string[] = [];
    const mine = resolvePluginConfig({ enabled: true, config: { agents: ["a"] } }, { plugins: { entries: { openwave: { enabled: false, config: { agents: ["b"] } } } } }, (m) => warns.push(m));
    expect(mine.source).toBe("xanima");
    expect(warns).toEqual([]);
    const legacy = resolvePluginConfig({ enabled: true }, OPENWAVE_020, (m) => warns.push(m));
    expect(legacy.source).toBe("openwave-legacy");
    expect((legacy.raw["config"] as Record<string, unknown>)["brainMode"]).toBe("remote");
    resolvePluginConfig({}, OPENWAVE_020, (m) => warns.push(m));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/DEPRECATED: reading settings from plugins\.entries\.openwave\.config/);
    expect(resolvePluginConfig({}, {}, () => {}).source).toBe("default");
  });

  test("warns when both entries are configured and openwave is still enabled", () => {
    const warns: string[] = [];
    resolvePluginConfig({ config: { agents: ["a"] } }, OPENWAVE_020, (m) => warns.push(m));
    expect(warns.join()).toMatch(/both plugins\.entries\.xanima and plugins\.entries\.openwave/);
  });

  test("the plugin really runs on an old openwave 0.2.0 config block (local mode)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xa-legacy-")); dirs.push(dir);
    const warns: string[] = [];
    const mock = makeMockApi({ enabled: true }, { configFile: { plugins: { entries: { openwave: { config: { agents: ["owlegacy"] } } } } } });
    (mock.api as { logger: unknown }).logger = { info() {}, debug() {}, error() {}, warn: (m: string) => warns.push(m) };
    plugin.register(mock.api as never);
    expect(warns.join("\n")).toMatch(/DEPRECATED: reading settings from plugins\.entries\.openwave/);
    const ctx = { agentId: "owlegacy", sessionKey: "agent:owlegacy:main", sessionId: "s1" };
    const write = mock.rec.tools.map((f: (c: unknown) => { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> }) => f(ctx)).find((t: { name: string }) => t.name === "brain_write")!;
    const r = await write.execute("w", { type: "semantic", label: "legacy", content: "served through the openwave config block" });
    expect(r.content[0]!.text).toMatch(/^Written: node/);
  });
});

describe("token env alias", () => {
  test("XANIMA_BRAIN_TOKEN, then OPENWAVE_BRAIN_TOKEN with a warning", () => {
    const warns: string[] = [];
    expect(brainTokenFromEnv({ XANIMA_BRAIN_TOKEN: "swt_new", OPENWAVE_BRAIN_TOKEN: "swt_old" } as NodeJS.ProcessEnv, (m) => warns.push(m))).toBe("swt_new");
    expect(warns).toEqual([]);
    const t = loadToken({}, "main", { OPENWAVE_BRAIN_TOKEN: "swt_old" } as NodeJS.ProcessEnv, (m) => warns.push(m));
    expect(t).toEqual({ ok: true, token: "swt_old", source: "env" });
    expect(warns.join()).toMatch(/OPENWAVE_BRAIN_TOKEN is deprecated; set \$XANIMA_BRAIN_TOKEN/);
    expect(warns.join()).not.toContain("swt_old");
  });
});

describe("upgradeOpenwaveConfig (openwave 0.2.0 → xanima 0.1.0)", () => {
  test("copies the block, disables (keeps) openwave, mirrors allow; idempotent; never overwrites", () => {
    const r = upgradeOpenwaveConfig(OPENWAVE_020);
    expect(r.changed).toBe(true);
    const e = (r.config["plugins"] as { entries: Record<string, { enabled?: boolean; config?: unknown }> }).entries;
    expect(e["xanima"]).toEqual({ enabled: true, config: OPENWAVE_020.plugins.entries.openwave.config });
    expect(e["openwave"]!.enabled).toBe(false);
    expect(e["openwave"]!.config).toEqual(OPENWAVE_020.plugins.entries.openwave.config);
    expect((r.config["plugins"] as { allow: string[] }).allow).toEqual(["openwave", "telegram", "xanima"]);
    expect(OPENWAVE_020.plugins.entries.openwave.enabled).toBe(true); // input untouched
    const again = upgradeOpenwaveConfig(r.config);
    expect(again.changed).toBe(false);
    expect(again.config).toEqual(r.config);
    const keep = upgradeOpenwaveConfig({ plugins: { entries: { openwave: { config: { agents: ["x"] } }, xanima: { config: { agents: ["mine"] } } } } });
    expect((keep.config["plugins"] as { entries: Record<string, { config: { agents: string[] } }> }).entries["xanima"]!.config.agents).toEqual(["mine"]);
    expect(upgradeOpenwaveConfig({}).changed).toBe(false);
  });

  test("CLI: dry run changes nothing; --write backs up then writes", () => {
    const cli = fileURLToPath(new URL("../dist/upgrade.js", import.meta.url));
    if (!existsSync(cli)) execFileSync(process.execPath, [fileURLToPath(new URL("../esbuild.mjs", import.meta.url))], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
    const dir = mkdtempSync(join(tmpdir(), "xa-upg-")); dirs.push(dir);
    const file = join(dir, "openclaw.json");
    writeFileSync(file, JSON.stringify(OPENWAVE_020, null, 2));
    const dry = execFileSync(process.execPath, [cli, "--config", file], { encoding: "utf8" });
    expect(dry).toMatch(/dry run/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(OPENWAVE_020);
    const out = execFileSync(process.execPath, [cli, "--config", file, "--write"], { encoding: "utf8" });
    expect(out).toMatch(/backup/);
    const backups = readdirSync(dir).filter((f) => f.includes(".pre-xanima-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, backups[0]!), "utf8"))).toEqual(OPENWAVE_020);
    expect(JSON.parse(readFileSync(file, "utf8")).plugins.entries.xanima.enabled).toBe(true);
    expect(execFileSync(process.execPath, [cli, "--config", file, "--write"], { encoding: "utf8" })).toMatch(/nothing to change/);
  });
});

describe("recall labels (remote block)", () => {
  const now = Date.UTC(2026, 9, 11, 12);
  const hit = (over: Record<string, unknown>) => ({ brain: "private" as const, id: "x", type: "semantic", label: "L", content: "C", score: 1, writer: "main", created_at: now - 3 * 86_400_000, confidence: "medium", confidence_score: 0.6, ...over });
  test("relative time, low-confidence marker, disputed, confirm-before-acting; flags off", () => {
    const b = formatRecallBlock([hit({}), hit({ label: "Low", confidence_score: 0.2 }), hit({ label: "D", contradicted_at: now, sensitivity: "confirm_before_acting" })], "chat", false, { now });
    expect(b.split("\n")).toEqual([
      RECALL_BLOCK_HEADER,
      "[semantic] L: C (3 days ago)",
      "[semantic] Low: C (3 days ago · low confidence (?))",
      "[semantic] D: C (3 days ago · disputed · confirm before acting)",
    ]);
    expect(formatRecallBlock([hit({ confidence_score: 0.2 })], "chat", false, { now, beliefMetadata: false })).toBe(`${RECALL_BLOCK_HEADER}\n[semantic] L: C (3 days ago)`);
    expect(formatRecallBlock([hit({ confidence_score: 0.2 })], "chat", false, { now, beliefMetadata: false, relativeTime: false })).toBe(`${RECALL_BLOCK_HEADER}\n[semantic] L: C`);
    // an older service without belief fields: no labels, no crash
    expect(formatRecallBlock([{ brain: "shared", id: "y", type: "semantic", label: "Old", content: "svc", score: 1, writer: null }], "chat", false, { now })).toBe(`${RECALL_BLOCK_HEADER}\n[semantic·shared] Old: svc`);
  });
});

describe("local-mode status footer", () => {
  test("appears on before_prompt_build only when the brain needs attention", async () => {
    const agent = `xafoot${Date.now().toString(36)}`;
    const mock = makeMockApi({ enabled: true, config: { agents: [agent] } });
    plugin.register(mock.api as never);
    const fire = async () => {
      const [res] = await mock.fire("before_prompt_build", { prompt: "anything about tea?" }, { agentId: agent, sessionKey: `agent:${agent}:main`, sessionId: "s-foot" });
      return (res as { appendSystemContext?: string } | undefined)?.appendSystemContext ?? "";
    };
    expect(await fire()).not.toContain("[BRAIN: status]");
    const a = core.writeNode(agent, "semantic", "Tea yes", "likes green tea", { deduplicate: false });
    const b = core.writeNode(agent, "semantic", "Tea no", "dislikes green tea", { deduplicate: false });
    core.writeEdge(agent, a, b, "contradicts");
    core.runBeliefReviewPass(agent, core.DEFAULT_CONFIG);
    expect(await fire()).toMatch(/\[BRAIN: status\] 2 disputed beliefs/);
  });
});
