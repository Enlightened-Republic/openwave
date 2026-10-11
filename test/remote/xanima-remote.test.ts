// Xanima 0.1.0 in remote mode against a REAL xanima-server: belief labels in
// the injected recall, the [BRAIN: status] footer, retract / supersede with a
// reason, and as_of through the proxied tools.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import plugin, { __remoteRuntimeForTests } from "../../src/index.js";
import { makeMockApi } from "../mock-api.js";
import { HAVE_SERVER, startServer, type RunningServer } from "./server-harness.js";

type Tool = { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> };
const AGENT = "xaremote";

describe.skipIf(!HAVE_SERVER)("xanima remote mode (real xanima-server)", () => {
  let svc: RunningServer;
  let tools: Map<string, Tool>;
  let mock: ReturnType<typeof makeMockApi>;
  const ctx = { agentId: AGENT, sessionKey: `agent:${AGENT}:main`, sessionId: "s-xa" };
  const call = async (n: string, p: Record<string, unknown>) => (await tools.get(n)!.execute(`c-${n}`, p)).content[0]!.text;
  const turn = async (prompt: string) => {
    const [res] = await mock.fire("before_prompt_build", { prompt }, ctx);
    return res as { appendSystemContext?: string; prependContext?: string };
  };

  beforeAll(async () => {
    svc = await startServer();
    svc.writeTokenFile(AGENT, svc.mint(AGENT, ["read", "write"]));
    mock = makeMockApi({ enabled: true, config: { agents: [AGENT], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token") } });
    plugin.register(mock.api as never);
    tools = new Map(mock.rec.tools.map((f: (c: unknown) => Tool) => f(ctx)).map((t: Tool) => [t.name, t]));
  }, 30_000);

  afterAll(async () => {
    await __remoteRuntimeForTests()?.stop();
    await svc?.stop();
  });

  test("recall lines carry age + low-confidence marker; supersede/retract/as_of work through the proxy", async () => {
    const w = await call("brain_write", { type: "semantic", label: "Quokka router", content: "The quokka router lives in the hall closet", confidence: "low", source_type: "user" });
    const id = /node ([0-9a-f-]{36})/.exec(w)![1]!;
    const r1 = await turn("where is the quokka router?");
    expect(r1.prependContext).toContain("Quokka router: The quokka router lives in the hall closet (just now · low confidence (?))");
    expect(r1.appendSystemContext).toMatch(/^\[Xanima remote\]/);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 15));
    const sup = await call("brain_supersede", { old_node_id: id, new_content: "The quokka router moved to the office shelf", reason: "Hailey moved it" });
    expect(sup).toMatch(/Reason: Hailey moved it/);
    const r2 = await turn("where is the quokka router?");
    expect(r2.prependContext).toContain("office shelf");
    expect(r2.prependContext).not.toContain("hall closet");
    const then = await call("brain_query", { query: "quokka router", as_of: t0 });
    expect(then).toContain("hall closet");
    expect(then).toMatch(/superseded/);
    const newId = /new node (\S+)/.exec(sup)![1]!;
    const rt = await call("brain_retract", { node_id: newId, reason: "router was returned" });
    expect(rt).toMatch(/Retracted/);
    const r3 = await turn("where is the quokka router?");
    expect(r3.prependContext ?? "").not.toContain("quokka router");
  });

  test("status footer appears once the brain needs attention (10+ low-confidence items)", async () => {
    for (let i = 0; i < 10; i++) await call("brain_write", { type: "semantic", label: `guess ${i}`, content: `unverified guess number ${i} about zebras`, confidence: 0.2 });
    // the footer is cached for 10 min per agent; restart the runtime cache by re-registering
    await __remoteRuntimeForTests()?.stop();
    mock = makeMockApi({ enabled: true, config: { agents: [AGENT], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token") } });
    plugin.register(mock.api as never);
    const st = await turn("tell me about zebras");
    expect(st.appendSystemContext).toMatch(/\[BRAIN: status\] \d+ low-confidence items — call brain_status for details\./);
    tools = new Map(mock.rec.tools.map((f: (c: unknown) => Tool) => f(ctx)).map((t: Tool) => [t.name, t]));
    expect(await call("brain_status", {})).toMatch(/\[private\] Brain status \(schema v23\)/);
  });
});
