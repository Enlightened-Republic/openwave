// Xanima 0.2.0 in remote mode against a REAL xanima-server: proxied decision /
// goal tools, the goals block from brain_turn_context (alignment note once,
// keyword trigger), and decision drafts from assistant episodes.
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import plugin, { __remoteRuntimeForTests } from "../../src/index.js";
import { makeMockApi } from "../mock-api.js";
import { HAVE_SERVER, SERVER_CLI, startServer, type RunningServer } from "./server-harness.js";

type Tool = { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> };
const AGENT = "xacont";

describe.skipIf(!HAVE_SERVER)("xanima 0.2.0 remote continuity (real xanima-server)", () => {
  let svc: RunningServer;
  let tools: Map<string, Tool>;
  let mock: ReturnType<typeof makeMockApi>;
  const ctx = { agentId: AGENT, sessionKey: `agent:${AGENT}:main`, sessionId: "s-xc" };
  const call = async (n: string, p: Record<string, unknown>) => (await tools.get(n)!.execute(`c-${n}`, p)).content[0]!.text;
  const turn = async (prompt: string) => {
    const [res] = await mock.fire("before_prompt_build", { prompt }, ctx);
    return (res as { prependContext?: string } | undefined)?.prependContext ?? "";
  };

  beforeAll(async () => {
    svc = await startServer(SERVER_CLI, { brain: { intentDriftCheck: "daily", driftDays: 7 } });
    svc.writeTokenFile(AGENT, svc.mint(AGENT, ["read", "write"]));
    mock = makeMockApi({ enabled: true, config: { agents: [AGENT], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token") } });
    plugin.register(mock.api as never);
    tools = new Map(mock.rec.tools.map((f: (c: unknown) => Tool) => f(ctx)).map((t: Tool) => [t.name, t]));
  }, 30_000);

  afterAll(async () => {
    await __remoteRuntimeForTests()?.stop();
    await svc?.stop();
  });

  test("goals block: alignment note once after drift, then a keyword trigger", async () => {
    const g = await call("brain_set_goal", { title: "Ship the billing migration", priority: "critical", keywords: ["billing"], triggers: [{ kind: "keyword", keywords: ["invoice"] }] });
    expect(g).toMatch(/P1 \[active\]/);
    const sup = await call("brain_update_goal", { goal_id: /Goal set: (\S+)/.exec(g)![1]!, action: "supersede", title: "Ship the billing migration by Nov 1", reason: "date agreed" });
    expect(sup).toMatch(/v1 → v2/);
    expect(await turn("hello there")).not.toContain("[BRAIN: goals]");
    const db = new Database(join(svc.root, "brains", AGENT, "brain.db"));
    db.prepare("UPDATE goals SET created_at = ?, last_progress_at = ?").run(Date.now() - 9 * 86_400_000, Date.now() - 9 * 86_400_000);
    db.prepare("DELETE FROM meta_kv WHERE key = 'drift:last_run'").run();
    db.close();
    const p1 = await turn("what's for lunch?");
    expect(p1).toMatch(/^\[BRAIN: goals\]\nAlignment: no progress on goal "Ship the billing migration by Nov 1" \(P1\) in 9 days/);
    expect(await turn("what's for dinner?")).not.toContain("[BRAIN: goals]");
    expect(await turn("send the invoice")).toMatch(/Goal P1 "Ship the billing migration by Nov 1" \(you mentioned "invoice"\)/);
    expect(await call("brain_status", {})).toMatch(/DRIFT .*billing migration/);
  });

  test("assistant replies become low-confidence decision drafts on the service", async () => {
    await mock.fire("llm_output", { assistantTexts: ["I'll go with Resend over SES because the API is simpler."] }, ctx);
    let txt = "";
    for (let i = 0; i < 40 && !/chose: Resend/.test(txt); i++) {
      await new Promise((r) => setTimeout(r, 100));
      txt = await call("brain_query_decisions", { status: "pending" });
    }
    expect(txt).toMatch(/Decision: Resend .*auto-extracted draft/);
    expect(txt).toMatch(/chose: Resend\s+\(over: SES\)/);
  });
});
