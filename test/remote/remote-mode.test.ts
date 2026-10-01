// Remote brain mode against a REAL sharpwave-server child process.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import plugin, { __remoteRuntimeForTests } from "../../src/index.js";
import { REMOTE_DOWN_NOTICE, REMOTE_BANNER, RECALL_BLOCK_HEADER, REMOTE_TOOL_NAMES } from "../../src/remote/register.js";
import { makeMockApi } from "../mock-api.js";
import { HAVE_SERVER, freePort, startBlackHole, startServer, type RunningServer } from "./server-harness.js";

type Logged = { level: string; msg: string };

function setup(config: Record<string, unknown>, opts: { workspaceDir?: string } = {}) {
  const m = makeMockApi({ enabled: true, config }, opts);
  const logs: Logged[] = [];
  (m.api as { logger: unknown }).logger = {
    info: (msg: string) => logs.push({ level: "info", msg }),
    warn: (msg: string) => logs.push({ level: "warn", msg }),
    error: (msg: string) => logs.push({ level: "error", msg }),
    debug: (msg: string) => logs.push({ level: "debug", msg }),
  };
  plugin.register(m.api as never);
  const runtime = __remoteRuntimeForTests();
  const tool = (name: string, agentId: string) => {
    const factory = m.rec.tools.find((t: (c: unknown) => { name: string }) => t({ agentId }).name === name);
    if (!factory) throw new Error(`tool ${name} not registered`);
    return factory({ agentId, sessionKey: `agent:${agentId}:main` });
  };
  const callTool = async (name: string, agentId: string, params: Record<string, unknown>) => {
    const r = await tool(name, agentId).execute("call-1", params);
    return r.content[0].text as string;
  };
  const prompt = async (agentId: string, text: string, sessionKey = `agent:${agentId}:main`) => {
    const [r] = await m.fire("before_prompt_build", { prompt: text }, { agentId, sessionKey, sessionId: `s-${agentId}` });
    return r as { appendSystemContext?: string; prependContext?: string } | undefined;
  };
  const cron = { added: [] as unknown[], removed: [] as string[], jobs: [] as Array<{ id: string; name: string }> };
  const cronService = {
    list: async () => cron.jobs,
    add: async (j: unknown) => { cron.added.push(j); },
    update: async () => {},
    remove: async (id: string) => { cron.removed.push(id); cron.jobs = cron.jobs.filter((j) => j.id !== id); return { removed: true }; },
  };
  const start = async () => {
    await m.fire("gateway_start", {}, { getCron: () => cronService });
    await __remoteRuntimeForTests()?.startupCheck;
  };
  return { ...m, logs, runtime, tool, callTool, prompt, cron, start };
}

const dataDir = () => process.env["SHARPWAVE_DATA_DIR"]!;
const noLocalBrain = (agentId: string) => expect(existsSync(join(dataDir(), agentId, "brain.db"))).toBe(false);

describe.skipIf(!HAVE_SERVER)("remote brain mode (real sharpwave-server)", () => {
  let svc: RunningServer;
  let alphaTok: string;
  let betaTok: string;
  const stops: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    svc = await startServer();
    alphaTok = svc.mint("ow-alpha", ["read", "write", "shared-write"]);
    betaTok = svc.mint("ow-beta", ["read", "write"]);
    svc.writeTokenFile("ow-alpha", alphaTok);
    svc.writeTokenFile("ow-beta", betaTok);
  }, 30_000);

  afterAll(async () => {
    for (const s of stops) await s().catch(() => {});
    await svc?.stop();
  });

  const remote = (agents: string[], extra: Record<string, unknown> = {}) => {
    const h = setup({ agents, brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token"), ...extra });
    stops.push(() => h.runtime!.stop());
    return h;
  };

  test("registers only the 11 service tools and no local cron; removes a stale openwave:consolidation job", async () => {
    const h = remote(["ow-alpha"]);
    expect(h.runtime).not.toBeNull();
    expect(h.rec.tools.map((t: (c: unknown) => { name: string }) => t({ agentId: "ow-alpha" }).name).sort()).toEqual([...REMOTE_TOOL_NAMES].sort());
    h.cron.jobs.push({ id: "openwave:consolidation", name: "openwave:consolidation" });
    await h.start();
    expect(h.cron.added).toEqual([]);
    expect(h.cron.removed).toEqual(["openwave:consolidation"]);
    expect(h.logs.some((l) => l.msg.includes('"op":"remote.health","outcome":"ok"'))).toBe(true);
    expect(h.logs.some((l) => l.msg.includes('"op":"remote.auth_check","outcome":"ok"') && l.msg.includes('"serviceAgentId":"ow-alpha"'))).toBe(true);
    expect(h.logs.some((l) => l.msg.includes("sleep_system"))).toBe(false);
    noLocalBrain("ow-alpha");
  });

  test("injection returns memories written via the service (existing block format)", async () => {
    const h = remote(["ow-alpha"]);
    await h.start();
    const w = await h.callTool("brain_write", "ow-alpha", { type: "semantic", label: "Gateway port fact", content: "The zebrafish gateway listens on port 18789 for openwave." });
    expect(w).toMatch(/Written: node [0-9a-f-]{36}/);
    const r = await h.prompt("ow-alpha", "which port does the zebrafish gateway use?");
    expect(r?.appendSystemContext).toBe(REMOTE_BANNER);
    expect(r?.prependContext).toContain(RECALL_BLOCK_HEADER);
    expect(r?.prependContext).toContain("[semantic] Gateway port fact: The zebrafish gateway listens on port 18789");
    noLocalBrain("ow-alpha");
  });

  test("writes are stamped with the token's agent, not a client-supplied writer", async () => {
    const h = remote(["ow-alpha"]);
    const w = await h.callTool("brain_write", "ow-alpha", { type: "semantic", label: "Stamp check", content: "kumquat stamping provenance check", writer_agent_id: "mallory" });
    expect(w).toContain("writer=ow-alpha");
    expect(w).not.toContain("writer=mallory");
    const q = JSON.parse(await h.callTool("brain_query", "ow-alpha", { query: "kumquat stamping", format: "json" }));
    const hit = q.results.find((x: { label: string }) => x.label === "Stamp check");
    expect(hit.writer).toBe("ow-alpha");
    expect(hit.brain).toBe("private");
  });

  test("shared vs private visibility: other agents see shared, never private; sharedRecall=false hides shared", async () => {
    const a = remote(["ow-alpha"]);
    await a.callTool("brain_write", "ow-alpha", { type: "semantic", label: "Alpha secret", content: "persimmon private note only alpha knows" });
    const shared = await a.callTool("brain_write", "ow-alpha", { type: "semantic", label: "Team rule", content: "persimmon shared rule for every agent", visibility: "shared" });
    expect(shared).toContain("brain=shared");

    // Beta cannot write shared (no shared-write scope) — surfaced as a tool error, not a crash.
    const b = remote(["ow-beta"]);
    const denied = await b.callTool("brain_write", "ow-beta", { type: "semantic", label: "x", content: "beta tries shared", visibility: "shared" });
    expect(denied).toMatch(/forbidden/i);

    const rb = await b.prompt("ow-beta", "tell me about persimmon");
    expect(rb?.prependContext).toContain("[semantic·shared] Team rule: persimmon shared rule");
    expect(rb?.prependContext ?? "").not.toContain("Alpha secret");

    const ra = await a.prompt("ow-alpha", "tell me about persimmon");
    expect(ra?.prependContext).toContain("[semantic] Alpha secret");
    expect(ra?.prependContext).toContain("[semantic·shared] Team rule");

    const bNoShared = remote(["ow-beta"], { sharedRecall: false });
    const rbn = await bNoShared.prompt("ow-beta", "tell me about persimmon");
    expect(rbn?.prependContext ?? "").not.toContain("Team rule");
    noLocalBrain("ow-beta");
  });

  test("one gateway serving two agents routes each to its own token via {agentId}", async () => {
    const h = remote(["ow-alpha", "ow-beta"]);
    const w = await h.callTool("brain_write", "ow-beta", { type: "semantic", label: "Beta own", content: "tamarind beta-only memory" });
    expect(w).toContain("writer=ow-beta");
    const rb = await h.prompt("ow-beta", "tamarind memory?");
    expect(rb?.prependContext).toContain("Beta own");
    const ra = await h.prompt("ow-alpha", "tamarind memory?");
    expect(ra?.prependContext ?? "").not.toContain("Beta own");
  });

  test("Graft A dedupe: identity/goal hits are dropped when MEMORY.md is curated", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const ws = mkdtempSync(join(tmpdir(), "ow-ws-"));
    writeFileSync(join(ws, "MEMORY.md"), "# curated\n");
    const plain = remote(["ow-alpha"]);
    await plain.callTool("brain_write", "ow-alpha", { type: "identity", label: "Who I am", content: "quokka identity statement" });
    await plain.callTool("brain_write", "ow-alpha", { type: "semantic", label: "Quokka fact", content: "quokka semantic fact" });
    const withMem = setup({ agents: ["ow-alpha"], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token") }, { workspaceDir: ws });
    stops.push(() => withMem.runtime!.stop());
    const r1 = await plain.prompt("ow-alpha", "quokka?");
    const r2 = await withMem.prompt("ow-alpha", "quokka?");
    // Without a curated tier the identity node is injected; with MEMORY.md it is not.
    expect(r1?.prependContext).toContain("Who I am");
    expect(r2?.prependContext).toContain("Quokka fact");
    expect(r2?.prependContext ?? "").not.toContain("Who I am");
  });

  test("LLM extraction facts are written to the service on session_end", async () => {
    const h = remote(["ow-alpha"], { llmExtractionEnabled: true, llmExtractionMinImportance: 0.4 });
    await h.fire("message_received", { content: "Remember: my favourite fruit is the rambutan, always." }, { agentId: "ow-alpha", sessionKey: "agent:ow-alpha:main", sessionId: "sx" });
    await h.fire("session_end", { sessionId: "sx", sessionKey: "agent:ow-alpha:main" }, { agentId: "ow-alpha" });
    const written = h.logs.find((l) => l.msg.includes('"op":"session_end.facts_written"'));
    expect(written?.msg).toContain('"target":"remote"');
    const q = await h.callTool("brain_query", "ow-alpha", { query: "rambutan", format: "json" });
    expect(JSON.parse(q).results.length).toBeGreaterThan(0);
    noLocalBrain("ow-alpha");
  });

  test("bad token is surfaced loudly (error log, status, tool message) and never logged", async () => {
    const bogus = "swt_THIS_IS_NOT_A_REAL_TOKEN_0123456789abcdef";
    const h = setup({ agents: ["ow-gamma"], brainMode: "remote", brainUrl: svc.url, brainToken: bogus });
    stops.push(() => h.runtime!.stop());
    await h.start();
    const err = h.logs.find((l) => l.level === "error" && l.msg.includes("BAD BRAIN TOKEN"));
    expect(err).toBeTruthy();
    expect(err!.msg).toContain('"status":401');
    const info = await h.callAction("getBrainConnection", {});
    expect(info.result.status).toBe("unauthorized");
    expect(info.result.tokenSource).toBe("inline");
    expect(JSON.stringify(info)).not.toContain(bogus);
    const t = await h.callTool("brain_query", "ow-gamma", { query: "anything" });
    expect(t).toMatch(/rejected this agent's token/);
    const r = await h.prompt("ow-gamma", "hello there friend");
    expect(r?.appendSystemContext).toBe(REMOTE_DOWN_NOTICE);
    expect(r?.prependContext).toBeUndefined();
    for (const l of h.logs) expect(l.msg).not.toContain(bogus);
    noLocalBrain("ow-gamma");
  });
});

describe("remote brain mode: degraded service (no server needed)", () => {
  test("unreachable service (connection refused) degrades within the timeout and rate-limits warnings", async () => {
    const port = await freePort(); // nothing listening
    const h = setup({ agents: ["ow-delta"], brainMode: "remote", brainUrl: `http://127.0.0.1:${port}`, brainToken: "swt_x", remoteTimeoutMs: 500 });
    try {
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        const r = await h.prompt("ow-delta", "what do you remember about lychees?");
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(r?.appendSystemContext).toBe(REMOTE_DOWN_NOTICE);
        expect(r?.prependContext).toBeUndefined();
      }
      const warns = h.logs.filter((l) => l.level === "warn" && l.msg.includes("before_prompt_build.recall"));
      expect(warns.length).toBe(1);
      const t = await h.callTool("brain_query", "ow-delta", { query: "x" });
      expect(t).toMatch(/unreachable/);
      noLocalBrain("ow-delta");
    } finally {
      await h.runtime!.stop();
    }
  });

  test("black-holed service (accepts, never answers) still returns within the timeout", async () => {
    const bh = await startBlackHole();
    const h = setup({ agents: ["ow-eps"], brainMode: "remote", brainUrl: bh.url, brainToken: "swt_x", remoteTimeoutMs: 400 });
    try {
      const t0 = Date.now();
      const r = await h.prompt("ow-eps", "what do you remember about lychees?");
      const took = Date.now() - t0;
      expect(took).toBeLessThan(1200);
      expect(r?.appendSystemContext).toBe(REMOTE_DOWN_NOTICE);
      // Backoff: the next turn fails fast instead of paying the timeout again.
      const t1 = Date.now();
      await h.prompt("ow-eps", "and now?");
      expect(Date.now() - t1).toBeLessThan(100);
    } finally {
      await h.runtime!.stop();
      await bh.stop();
    }
  });

  test("gateway_start never blocks on a down service; health check retries with backoff and the cron is not registered", async () => {
    const port = await freePort();
    const h = setup({ agents: ["ow-zeta"], brainMode: "remote", brainUrl: `http://127.0.0.1:${port}`, brainToken: "swt_x", remoteTimeoutMs: 300 });
    try {
      const t0 = Date.now();
      await h.fire("gateway_start", {}, { getCron: () => ({ list: async () => [], add: async () => { throw new Error("must not add"); }, update: async () => {}, remove: async () => ({}) }) });
      expect(Date.now() - t0).toBeLessThan(500);
      await new Promise((r) => setTimeout(r, 1500));
      const health = h.logs.filter((l) => l.msg.includes('"op":"remote.health"'));
      expect(health.length).toBeGreaterThanOrEqual(1);
      expect(health[0]!.msg).toContain('"outcome":"unreachable"');
      expect(h.logs.some((l) => l.msg.includes("cron.consolidation") && l.msg.includes("registered"))).toBe(false);
      const info = await h.callAction("getBrainConnection", {});
      expect(info.result.status).toBe("unreachable");
    } finally {
      await h.runtime!.stop();
    }
  });

  test("missing token file is a clear config error, no crash, no local brain", async () => {
    const h = setup({ agents: ["ow-eta"], brainMode: "remote", brainTokenFile: "/nonexistent/dir/{agentId}.token" });
    const err = h.logs.find((l) => l.level === "error" && l.msg.includes("remote.token"));
    expect(err?.msg).toContain("cannot read brainTokenFile (ENOENT): /nonexistent/dir/ow-eta.token");
    const r = await h.prompt("ow-eta", "anything at all");
    expect(r?.appendSystemContext).toBe(REMOTE_DOWN_NOTICE);
    const info = await h.callAction("getBrainConnection", {});
    expect(info.result.status).toBe("misconfigured");
    noLocalBrain("ow-eta");
  });

  test("local mode (default) is unchanged: local tools, local cron, no remote runtime", async () => {
    const h = setup({ agents: ["ow-local"] });
    expect(__remoteRuntimeForTests()).toBeNull();
    expect(h.rec.tools.length).toBe(16);
    await h.fire("gateway_start", {}, { getCron: () => ({ list: async () => [], add: async (j: unknown) => { h.cron.added.push(j); }, update: async () => {}, remove: async () => ({}) }) });
    expect(h.cron.added.length).toBe(1);
    expect(existsSync(join(dataDir(), "ow-local", "brain.db"))).toBe(true);
    await h.fire("gateway_stop", {}, {});
    const info = await h.callAction("getBrainConnection", {});
    expect(info.result.brainMode).toBe("local");
    expect(info.result.status).toBe("local");
    void readdirSync;
  });
});
