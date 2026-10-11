// Xanima 0.2.0 in LOCAL mode: the [BRAIN: goals] block (alignment note once +
// keyword trigger) on before_prompt_build, and decision drafts from llm_output.
import { expect, test } from "vitest";
import * as core from "xanima-core";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

const prependOf = (out: unknown[]) =>
  (out.find((r) => (r as { prependContext?: string })?.prependContext) as { prependContext?: string })?.prependContext ?? "";

test("local: goals block carries the alignment note until a real reply (not a tool-only turn) and fires keyword triggers; flags turn it off", async () => {
  const agent = "contlocal";
  const mock = makeMockApi({ enabled: true, config: { agents: [agent] } });
  plugin.register(mock.api as never);
  const ctx = { agentId: agent, sessionKey: `agent:${agent}:main`, sessionId: "cl-1" };
  const g = core.setGoal(agent, { title: "Ship the billing migration", priority: 1, keywords: ["billing"], triggers: [{ kind: "keyword", keywords: ["invoice"] }], now: Date.now() - 10 * 86_400_000 });
  expect(g.ok).toBe(true);
  core.runDriftPass(agent, core.DEFAULT_CONFIG);
  const p1 = prependOf(await mock.fire("before_prompt_build", { prompt: "what's for lunch today?" }, ctx));
  expect(p1).toMatch(/\[BRAIN: goals\]\nAlignment: no progress on goal "Ship the billing migration" \(P1\) in 10 days/);
  // that turn only called a memory tool → the note is NOT used up
  await mock.fire("before_tool_call", { toolName: "tool_call", params: { id: "brain_status", args: {} } }, ctx);
  await mock.fire("llm_output", { assistantTexts: ["TOOL brain_status RESULT: …"] }, ctx);
  expect(core.computeBrainStatus(core.getDb(agent), core.DEFAULT_CONFIG).goals.pendingNote).toMatch(/no progress/);
  const p1b = prependOf(await mock.fire("before_prompt_build", { prompt: "what's for lunch, really?" }, ctx));
  expect(p1b).toMatch(/\[BRAIN: goals\]\nAlignment: no progress/);
  // a real reply → delivered
  await mock.fire("llm_output", { assistantTexts: ["Tacos from the place on 5th."] }, ctx);
  expect(core.computeBrainStatus(core.getDb(agent), core.DEFAULT_CONFIG).goals.pendingNote).toBeNull();
  const p2 = prependOf(await mock.fire("before_prompt_build", { prompt: "what's for lunch tomorrow?" }, ctx));
  expect(p2).not.toContain("[BRAIN: goals]");
  const p3 = prependOf(await mock.fire("before_prompt_build", { prompt: "please send the invoice" }, ctx));
  expect(p3).toMatch(/Goal P1 "Ship the billing migration" \(you mentioned "invoice"\)/);
});

test("local: llm_output drafts a decision from the agent's own choice; decisionAutoExtract:false does not", async () => {
  const on = "contdraft";
  const mock = makeMockApi({ enabled: true, config: { agents: [on] } });
  plugin.register(mock.api as never);
  const ctx = { agentId: on, sessionKey: `agent:${on}:main`, sessionId: "cd-1" };
  await mock.fire("llm_output", { assistantTexts: ["I'll go with SQLite over Postgres because there is one writer."] }, ctx);
  const d = core.queryDecisions(on, {});
  expect(d.map((x) => [x.chosen, x.auto_extracted, x.confidence])).toEqual([["SQLite", 1, "low"]]);

  const off = "contnodraft";
  const mock2 = makeMockApi({ enabled: true, config: { agents: [off], decisionAutoExtract: false } });
  plugin.register(mock2.api as never);
  await mock2.fire("llm_output", { assistantTexts: ["I'll go with SQLite over Postgres because there is one writer."] }, { agentId: off, sessionKey: `agent:${off}:main`, sessionId: "cd-2" });
  expect(core.queryDecisions(off, {})).toEqual([]);
});
