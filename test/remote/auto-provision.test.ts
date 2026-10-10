// Integration: agents:"*" + autoProvision against a REAL sharpwave-server built
// from the engram/agent-provisioning branch (brain_provision_agent + provision scope).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import plugin, { __remoteRuntimeForTests } from "../../src/index.js";
import { RECALL_BLOCK_HEADER } from "../../src/remote/register.js";
import { RemoteBrainClient } from "../../src/remote/client.js";
import { makeMockApi } from "../mock-api.js";
import { HAVE_SERVER, startServer, type RunningServer } from "./server-harness.js";

type OcConfig = { agents: { list: Array<{ id: string; name?: string }> } };

describe.skipIf(!HAVE_SERVER)("auto-provisioning (real sharpwave-server)", () => {
  let svc: RunningServer;
  let provTok: string;
  let provFile: string;
  const stops: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    svc = await startServer();
    const tools = await (async () => {
      const t = svc.mint("probe", ["read"]);
      const c = new RemoteBrainClient({ url: svc.url, token: t, timeoutMs: 3000, agentId: "probe", clientVersion: "test" });
      const names = await c.toolNames(); await c.close(); return names;
    })();
    if (tools.has("brain_provision_agent")) throw new Error("provision tool must be hidden from non-provision tokens");
    provTok = svc.mint("openwave-provisioner", ["provision"]);
    svc.writeTokenFile("_provisioner", provTok);
    provFile = join(svc.tokenDir, "_provisioner.token");
  }, 30_000);
  afterAll(async () => { for (const s of stops) await s().catch(() => {}); await svc?.stop(); });

  const setup = (oc: OcConfig, extra: Record<string, unknown> = {}) => {
    const m = makeMockApi({ enabled: true, config: {
      agents: "*", brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token"),
      autoProvision: true, provisionTokenFile: provFile, rosterPollMs: 0, ...extra,
    } }, { configFile: oc as unknown as Record<string, unknown> });
    const logs: string[] = [];
    (m.api as { logger: unknown }).logger = { info: (s: string) => logs.push(s), warn: (s: string) => logs.push(s), error: (s: string) => logs.push(s), debug: () => {} };
    plugin.register(m.api as never);
    const rt = __remoteRuntimeForTests()!;
    stops.push(() => rt.stop());
    const prompt = async (agentId: string, text: string) =>
      (await m.fire("before_prompt_build", { prompt: text }, { agentId, sessionKey: `agent:${agentId}:main`, sessionId: `s-${agentId}` }))[0] as { prependContext?: string; appendSystemContext?: string } | undefined;
    const tool = (name: string, agentId: string) => m.rec.tools.map((f: (c: unknown) => any) => f({ agentId, sessionKey: `agent:${agentId}:main` })).find((t: any) => t.name === name);
    const start = async () => { await m.fire("gateway_start", {}, {}); await rt.startupCheck; await rt.syncRoster(); };
    return { m, logs, rt, prompt, tool, start };
  };

  test("gateway_start provisions every agent without a token file; tokens written owner-only and never logged", async () => {
    const oc: OcConfig = { agents: { list: [{ id: "ap-main", name: "Tripp" }, { id: "ap-gion" }] } };
    const h = setup(oc);
    await h.start();
    for (const id of ["ap-main", "ap-gion"]) {
      const p = join(svc.tokenDir, `${id}.token`);
      expect(existsSync(p)).toBe(true);
      if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
      const tok = readFileSync(p, "utf8").trim();
      expect(tok).toMatch(/^swt_/);
      expect(h.logs.join("\n")).not.toContain(tok);
      expect(svc.logs()).not.toContain(tok);
    }
    expect(h.logs.join("\n")).not.toContain(provTok);
    const tokens = JSON.parse(readFileSync(join(svc.root, "tokens.json"), "utf8")).tokens as Array<{ agentId: string; scopes: string[]; label?: string }>;
    const main = tokens.find((t) => t.agentId === "ap-main")!;
    expect(main.scopes).toEqual(["read", "write", "shared-write"]);
    expect(main.label).toBe("ap-main (Tripp) via OpenWave");
  });

  test("a NEW agent added to the live OpenClaw config gets provisioned and has working memory on its FIRST turn, no restart/re-register", async () => {
    const oc: OcConfig = { agents: { list: [{ id: "ap-x1" }] } };
    const h = setup(oc);
    await h.start();
    const registerCount = h.m.rec.tools.length;
    oc.agents.list.push({ id: "ap-gano", name: "Gano" }); // `openclaw agents add` hot-applies the config
    expect(existsSync(join(svc.tokenDir, "ap-gano.token"))).toBe(false);
    // First turn: tool write, then recall — all on the very first contact.
    const w = await h.tool("brain_write", "ap-gano").execute("c1", { type: "semantic", label: "Gano fact", content: "Gano builds narwhal racing games in Godot" });
    expect(w.content[0].text).toMatch(/Written: node/);
    expect(w.content[0].text).toContain("writer=ap-gano");
    expect(existsSync(join(svc.tokenDir, "ap-gano.token"))).toBe(true);
    const r = await h.prompt("ap-gano", "what games does Gano build with narwhals?");
    expect(r?.prependContext).toContain(RECALL_BLOCK_HEADER);
    expect(r?.prependContext).toContain("narwhal racing");
    expect(h.m.rec.tools.length).toBe(registerCount);
    expect(h.logs.some((l) => l.includes('"op":"agent.activated"') && l.includes("ap-gano"))).toBe(true);
    expect(h.logs.some((l) => l.includes('"op":"provision"') && l.includes('"outcome":"provisioned"'))).toBe(true);
  });

  test("first turn via before_prompt_build alone also provisions (prompt-only path)", async () => {
    const oc: OcConfig = { agents: { list: [] } };
    const h = setup(oc);
    await h.start();
    oc.agents.list.push({ id: "ap-wren" });
    const r = await h.prompt("ap-wren", "hello there brain");
    expect(r?.appendSystemContext).not.toMatch(/unavailable/);
    expect(existsSync(join(svc.tokenDir, "ap-wren.token"))).toBe(true);
  });

  test("idempotent: re-register/restart with existing token files mints nothing new", async () => {
    const before = JSON.parse(readFileSync(join(svc.root, "tokens.json"), "utf8")).tokens.length;
    const oc: OcConfig = { agents: { list: [{ id: "ap-main" }, { id: "ap-gion" }] } };
    const h = setup(oc);
    await h.start();
    await h.start();
    const after = JSON.parse(readFileSync(join(svc.root, "tokens.json"), "utf8")).tokens.length;
    expect(after).toBe(before);
    expect(h.logs.some((l) => l.includes('"op":"remote.auth_check","outcome":"ok"') && l.includes("ap-main"))).toBe(true);
  });

  test("excluded agents are skipped: no provisioning, no memory, tools refuse", async () => {
    const oc: OcConfig = { agents: { list: [{ id: "ap-cade" }, { id: "ap-secret" }] } };
    const h = setup(oc, { excludeAgents: ["ap-secret"] });
    await h.start();
    expect(existsSync(join(svc.tokenDir, "ap-cade.token"))).toBe(true);
    expect(existsSync(join(svc.tokenDir, "ap-secret.token"))).toBe(false);
    expect(await h.prompt("ap-secret", "anything here?")).toBeUndefined();
    const t = await h.tool("brain_query", "ap-secret").execute("c", { query: "x" });
    expect(t.content[0].text).toContain("not serving");
    expect(existsSync(join(svc.root, "brains", "ap-secret"))).toBe(false);
  });

  test("the provisioner token cannot read or write any brain", async () => {
    const c = new RemoteBrainClient({ url: svc.url, token: provTok, timeoutMs: 3000, agentId: "p", clientVersion: "test" });
    expect([...(await c.toolNames())]).toEqual(["brain_provision_agent"]);
    for (const [n, a] of [["brain_query", { query: "narwhal" }], ["brain_write", { type: "semantic", label: "x", content: "y" }], ["brain_stats", {}], ["brain_episode_append", { role: "user", content: "x" }]] as const) {
      const r = await c.callTool(n, a as Record<string, unknown>);
      expect(r.isError, n).toBe(true);
      expect(r.text).toMatch(/forbidden/i);
    }
    await c.close();
  });

  test("service down: turn is not broken, provisioning logs a clear retry-with-backoff warning, no token file", async () => {
    const oc: OcConfig = { agents: { list: [] } };
    const h = setup(oc, { brainUrl: "http://127.0.0.1:1", remoteTimeoutMs: 300 });
    oc.agents.list.push({ id: "ap-down" });
    const r = await h.prompt("ap-down", "is anyone there?");
    expect(r?.appendSystemContext).toMatch(/unavailable/);
    expect(h.logs.some((l) => l.includes('"op":"provision"') && l.includes("will retry with backoff"))).toBe(true);
    expect(existsSync(join(svc.tokenDir, "ap-down.token"))).toBe(false);
  });

  test("explicit-list mode is unchanged: no provisioning, ignores OpenClaw roster", async () => {
    const m = makeMockApi({ enabled: true, config: { agents: ["ap-main"], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token") } },
      { configFile: { agents: { list: [{ id: "ap-main" }, { id: "ap-new" }] } } });
    plugin.register(m.api as never);
    const rt = __remoteRuntimeForTests()!;
    stops.push(() => rt.stop());
    await m.fire("gateway_start", {}, {});
    await rt.startupCheck;
    expect(rt.servedIds()).toEqual(["ap-main"]);
    expect(rt.served("ap-new")).toBe(false);
    expect(await rt.ensureAgent("ap-new")).toBe(false);
    expect(existsSync(join(svc.tokenDir, "ap-new.token"))).toBe(false);
  });
});
