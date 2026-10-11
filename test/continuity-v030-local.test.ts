// Xanima 0.3.0 in LOCAL mode: commitment nudge + alignment note offered together
// and acked together only after a real reply; open items captured from
// llm_output and surfaced when a later prompt is about them; flags turn it off.
import { expect, test } from "vitest";
import * as core from "xanima-core";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

const prependOf = (out: unknown[]) =>
  (out.find((r) => (r as { prependContext?: string })?.prependContext) as { prependContext?: string })?.prependContext ?? "";
const DAY = 86_400_000;

test("local: overdue commitment nudge + alignment note survive a tool-only turn and are both consumed by a real reply", async () => {
  const agent = "v030local";
  const mock = makeMockApi({ enabled: true, config: { agents: [agent] } });
  plugin.register(mock.api as never);
  const ctx = { agentId: agent, sessionKey: `agent:${agent}:main`, sessionId: "v3-1" };
  core.setGoal(agent, { title: "Ship the billing migration", priority: 1, now: Date.now() - 10 * DAY });
  core.runDriftPass(agent, core.DEFAULT_CONFIG);
  core.createCommitment(agent, { title: "send Hailey the migration report", due: Date.now() - DAY, now: Date.now() - 3 * DAY });
  const p1 = prependOf(await mock.fire("before_prompt_build", { prompt: "what's for lunch?" }, ctx));
  expect(p1).toMatch(/Alignment: no progress/);
  expect(p1).toMatch(/Commitment overdue: "send Hailey the migration report"/);
  await mock.fire("before_tool_call", { toolName: "brain_commitments", params: {} }, ctx);
  await mock.fire("llm_output", { assistantTexts: ["TOOL brain_commitments RESULT: …"] }, ctx);
  let st = core.computeBrainStatus(core.getDb(agent), core.DEFAULT_CONFIG);
  expect(st.goals.pendingNote).toMatch(/no progress/);
  expect(st.commitments.pendingNudge).toMatch(/overdue/);
  expect(prependOf(await mock.fire("before_prompt_build", { prompt: "lunch?" }, ctx))).toMatch(/Commitment overdue/);
  await mock.fire("llm_output", { assistantTexts: ["Sending the report now, sorry it's late."] }, ctx);
  st = core.computeBrainStatus(core.getDb(agent), core.DEFAULT_CONFIG);
  expect(st.goals.pendingNote).toBeNull();
  expect(st.commitments.pendingNudge).toBeNull();
  expect(st.commitments.overdue).toHaveLength(1); // still overdue until done — status keeps showing it
  expect(prependOf(await mock.fire("before_prompt_build", { prompt: "and dinner?" }, ctx))).not.toContain("[BRAIN: goals]");
});

test("local: llm_output captures open items; a later prompt about one surfaces it; openItemCapture:false does not capture", async () => {
  const agent = "v030open";
  const mock = makeMockApi({ enabled: true, config: { agents: [agent] } });
  plugin.register(mock.api as never);
  const ctx = { agentId: agent, sessionKey: `agent:${agent}:main`, sessionId: "v3-2" };
  await mock.fire("llm_output", { assistantTexts: ["I think the invoices fail because the Stripe webhook secret rotated. Open question: does the staging webhook share that secret?"] }, ctx);
  const items = core.listOpenItems(agent, {});
  expect(items.map((i) => [i.kind, i.draft_status]).sort()).toEqual([["hypothesis", "pending"], ["question", "pending"]]);
  const p = prependOf(await mock.fire("before_prompt_build", { prompt: "can you check the staging webhook secret?" }, ctx));
  expect(p).toMatch(/Open question \(asked .*\): does the staging webhook share that secret/);
  const off = "v030noopen";
  const mock2 = makeMockApi({ enabled: true, config: { agents: [off], openItemCapture: false } });
  plugin.register(mock2.api as never);
  await mock2.fire("llm_output", { assistantTexts: ["I think the invoices fail because the secret rotated."] }, { agentId: off, sessionKey: `agent:${off}:main`, sessionId: "v3-3" });
  expect(core.listOpenItems(off, {})).toEqual([]);
});

test("local: the 0.3.0 tools are registered and run", async () => {
  const agent = "v030tools";
  const mock = makeMockApi({ enabled: true, config: { agents: [agent] } });
  plugin.register(mock.api as never);
  const ctx = { agentId: agent, sessionKey: `agent:${agent}:main`, sessionId: "v3-4" };
  type Tool = { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> };
  const tools = new Map(mock.rec.tools.map((f: (c: unknown) => Tool) => f(ctx)).map((t: Tool) => [t.name, t]));
  const call = async (n: string, p: Record<string, unknown>) => (await tools.get(n)!.execute(`c-${n}`, p)).content[0]!.text;
  const pl = await call("brain_plan", { action: "create", title: "Billing migration", steps: ["export", "import", "verify"] });
  const id = /^([0-9a-f-]{36}) Plan/m.exec(pl)![1]!;
  await call("brain_plan", { action: "park", plan_id: id, note: "waiting on finance" });
  expect(await call("brain_plan", { action: "resume", plan_id: id })).toMatch(/Plan resumed[\s\S]*Still open: 3 of 3 steps/);
  expect(await call("brain_forget_impact", { query: "billing" })).toMatch(/dry run/);
  expect(await call("brain_reflect", { since: "7 days ago" })).toMatch(/Nothing to reflect on/);
});
