// Xanima 0.3.0 in remote mode against a REAL xanima-server: the turn context
// carries the commitment nudge + a relevant open question, both acked with
// ack_note_ids only after a real reply; open items captured from assistant
// episodes; the proxied 0.3.0 tools work on the private brain.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import plugin, { __remoteRuntimeForTests } from "../../src/index.js";
import { makeMockApi } from "../mock-api.js";
import { HAVE_SERVER, SERVER_CLI, startServer, type RunningServer } from "./server-harness.js";

type Tool = { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> };
const AGENT = "xav030";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAVE_SERVER)("xanima 0.3.0 remote (real xanima-server)", () => {
  let svc: RunningServer;
  let tools: Map<string, Tool>;
  let mock: ReturnType<typeof makeMockApi>;
  const ctx = { agentId: AGENT, sessionKey: `agent:${AGENT}:main`, sessionId: "s-x3" };
  const call = async (n: string, p: Record<string, unknown>) => (await tools.get(n)!.execute(`c-${n}`, p)).content[0]!.text;
  const turn = async (prompt: string) => {
    const [res] = await mock.fire("before_prompt_build", { prompt }, ctx);
    return (res as { prependContext?: string } | undefined)?.prependContext ?? "";
  };

  beforeAll(async () => {
    svc = await startServer(SERVER_CLI, { brain: { reflection: "sleep" } });
    svc.writeTokenFile(AGENT, svc.mint(AGENT, ["read", "write"]));
    mock = makeMockApi({ enabled: true, config: { agents: [AGENT], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token") } });
    plugin.register(mock.api as never);
    tools = new Map(mock.rec.tools.map((f: (c: unknown) => Tool) => f(ctx)).map((t: Tool) => [t.name, t]));
  }, 30_000);

  afterAll(async () => {
    await __remoteRuntimeForTests()?.stop();
    await svc?.stop();
  });

  test("commitment nudge + open question: offered until a real reply, then acked", async () => {
    expect(await call("brain_commit", { action: "create", title: "send Hailey the dinner plan", due: "2 days ago" })).toMatch(/Commitment recorded/);
    expect(await call("brain_question", { action: "ask", question: "Which taqueria takes reservations for groups?" })).toMatch(/Recorded question/);
    const p1 = await turn("let's find a taqueria that takes a reservation for the group");
    expect(p1).toMatch(/Commitment overdue: "send Hailey the dinner plan"/);
    expect(p1).toMatch(/Open question .*taqueria takes reservations/);
    await mock.fire("before_tool_call", { toolName: "tool_call", params: { id: "brain_commitments", args: {} } }, ctx);
    await mock.fire("llm_output", { assistantTexts: ["TOOL brain_commitments RESULT: …"] }, ctx);
    await wait(150);
    expect(await call("brain_status", {})).toMatch(/commitment nudge pending/);
    expect(await turn("hello")).toMatch(/Commitment overdue/);
    await mock.fire("llm_output", { assistantTexts: ["Here's the dinner plan: tacos at 7."] }, ctx);
    await wait(200);
    const st = await call("brain_status", {});
    expect(st).not.toMatch(/commitment nudge pending/);
    expect(st).toMatch(/OVERDUE .*send Hailey the dinner plan/);
  });

  test("assistant replies are captured as open-item drafts on the service; plan park → resume briefing", async () => {
    await mock.fire("llm_output", { assistantTexts: ["I think the reservation failed because the group was over 8 people."] }, ctx);
    let txt = "";
    for (let i = 0; i < 40 && !/over 8 people/.test(txt); i++) { await wait(100); txt = await call("brain_list_open", { kind: "hypothesis" }); }
    expect(txt).toMatch(/Hypothesis \[open\] the reservation failed .*captured draft/);
    const pl = await call("brain_plan", { action: "create", title: "Dinner logistics", steps: ["book", "invite", "pay"] });
    const id = /^([0-9a-f-]{36}) Plan/m.exec(pl)![1]!;
    await call("brain_plan", { action: "park", plan_id: id, note: "waiting on headcount" });
    await call("brain_plan", { action: "step", plan_id: id, step: 1, status: "done" });
    const r = await call("brain_plan", { action: "resume", plan_id: id });
    expect(r).toMatch(/Plan resumed[\s\S]*Still open: 2 of 3 steps; next: 2\. invite[\s\S]*step: 1\. book → done/);
    expect(await call("brain_forget_impact", { query: "dinner" })).toMatch(/dry run — nothing changed/);
  });
});
