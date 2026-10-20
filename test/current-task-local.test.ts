// Xanima 0.7 in LOCAL mode: the current task and handoffs through the plugin's hooks.
//   - the owner's words on message_received hand a goal / plan off and pin the new task (owner turns only);
//   - before_prompt_build injects [BRAIN: now] first; a bare "continue" skips recall, adds this session's
//     last turns, and holds the alignment nudge;
//   - brain_now is per conversation (tool context session key);
//   - heartbeats see the agent's latest task and recent handoffs;
//   - after_compaction restores the task from the summary and leaves a state episode.
import { expect, test } from "vitest";
import * as core from "xanima-core";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

type ToolCtx = { agentId?: string; sessionKey?: string; sessionId?: string };
type ToolResult = { content?: Array<{ type: string; text: string }>; details?: { error?: string } };
const DAY = 86_400_000;
const prependOf = (out: unknown[]) => (out.find((r) => (r as { prependContext?: string })?.prependContext) as { prependContext?: string })?.prependContext ?? "";
const appendOf = (out: unknown[]) => (out.find((r) => (r as { appendContext?: string })?.appendContext) as { appendContext?: string })?.appendContext ?? "";
function buildTool(mock: ReturnType<typeof makeMockApi>, name: string, ctx: ToolCtx) {
  for (const entry of mock.rec.tools) {
    const def = typeof entry === "function" ? entry(ctx) : entry;
    if (def?.name === name) return def as { execute: (id: string, params: unknown) => Promise<ToolResult> };
  }
  throw new Error(`tool not registered: ${name}`);
}
const textOf = (r: ToolResult) => r?.content?.[0]?.text ?? "";

test("local: the owner hands a project off and switches task in conversation; 'continue' then means the new task", async () => {
  const agent = "ctlocal";
  const mock = makeMockApi({ enabled: true, config: { agents: [agent] } }); // no owner list → a clean turn is the owner's
  plugin.register(mock.api as never);
  const S = `agent:${agent}:main`;
  const ctx = { agentId: agent, sessionKey: S, sessionId: "ct-1" };
  const now = Date.now();
  // an old, stale P1 goal with a plan, and a drift note about it
  const gano = core.setGoal(agent, { title: "Ship the Gano Telegram bot", priority: 1, successCriteria: "Gano answers", now: now - 12 * DAY }).goal!;
  const ganoPlan = core.createPlan(agent, { title: "Gano Telegram bot rollout", goalId: gano.lineage_id, steps: ["token", "webhook"], now: now - 6 * DAY }).plan!;
  core.writeNode(agent, "semantic", "Continue the Gano bot rollout", "Continue the Gano Telegram bot rollout once the token arrives", { importance: 0.8 });
  core.runDriftPass(agent, core.DEFAULT_CONFIG, undefined, now);
  // before the handoff: "continue" gets no recall and no nudge, and no now block (nothing to say yet)
  const p0 = prependOf(await mock.fire("before_prompt_build", { prompt: "continue" }, ctx));
  expect(p0).not.toMatch(/\[BRAIN: on your mind|Alignment:/);
  // the owner speaks
  await mock.fire("message_received", { content: "Hand the Gano Telegram bot off to Mia. Let's work on the billing migration now." }, ctx);
  expect(core.currentGoalRow(agent, gano.lineage_id)).toMatchObject({ status: "handed_off", handoff_to: "Mia" });
  expect(core.getPlan(agent, ganoPlan.node_id)).toMatchObject({ status: "handed_off", handoff_to: "Mia" });
  expect(core.getTaskFrame(agent, S, core.DEFAULT_CONFIG)).toMatchObject({ title: "billing migration", set_by: "owner" });
  // the agent replies and works
  await mock.fire("llm_output", { assistantTexts: ["On it — starting with the invoice export."] }, ctx);
  // next turn: now block first, then on "continue": this session's turns, no topic recall, no nudge
  const p1 = prependOf(await mock.fire("before_prompt_build", { prompt: "continue" }, ctx));
  expect(p1).toMatch(/^\[BRAIN: now\]\nWorking on: billing migration \(your owner said so, just now\)\nHanded off just now: (plan|goal) "/);
  expect(p1).toMatch(/Handed off just now: goal "Ship the Gano Telegram bot" → Mia \(owner said: "Hand the Gano Telegram bot off to Mia\."\) — theirs now, not yours\./);
  expect(p1).toMatch(/"continue" means the task above/);
  expect(p1).toMatch(/\[BRAIN: this session, last turns\]\nthem \(just now\): Hand the Gano Telegram bot off to Mia[\s\S]*you \(just now\): On it/);
  expect(p1).not.toMatch(/\[BRAIN: on your mind|Alignment:/);
  // a topical prompt still recalls, and the nudge about the handed-off goal is gone for good (superseded)
  const p2 = prependOf(await mock.fire("before_prompt_build", { prompt: "continue the Gano rollout" }, ctx)); // names a topic → not content-free
  expect(p2).toMatch(/\[BRAIN: on your mind[\s\S]*Gano/);
  expect(p2).not.toMatch(/this session, last turns/);
  expect(p2).not.toMatch(/Alignment:/);
  // the goal header no longer lists it
  const sys = (await mock.fire("before_prompt_build", { prompt: "hello" }, ctx)).find((r) => (r as { appendSystemContext?: string })?.appendSystemContext) as { appendSystemContext: string };
  expect(sys.appendSystemContext).not.toMatch(/Gano/);
  // brain_now from a tool call is per conversation
  const other = { agentId: agent, sessionKey: `agent:${agent}:telegram`, sessionId: "ct-2" };
  expect(textOf(await buildTool(mock, "brain_now", other).execute("t1", { action: "get" }))).toMatch(/^No current task set for this conversation/);
  expect(textOf(await buildTool(mock, "brain_now", ctx).execute("t2", { action: "get" }))).toMatch(/^Working on: billing migration/);
  expect(textOf(await buildTool(mock, "brain_plan", other).execute("t3", { action: "create", title: "Answer the group chat", steps: ["read", "reply"] }))).toMatch(/pinned as this session's current task/);
  expect(core.getTaskFrame(agent, other.sessionKey, core.DEFAULT_CONFIG)!.title).toBe("Answer the group chat");
  expect(core.getTaskFrame(agent, S, core.DEFAULT_CONFIG)!.title).toBe("billing migration");
  // heartbeat: the latest task across sessions, plus the handoffs
  const hb = appendOf(await mock.fire("heartbeat_prompt_contribution", {}, { agentId: agent, sessionKey: `agent:${agent}:heartbeat` }));
  expect(hb).toMatch(/\[BRAIN: now\]\nWorking on: Answer the group chat[\s\S]*Handed off just now: goal "Ship the Gano Telegram bot" → Mia/);
});

test("local: a cron turn and a non-owner sender never change task state; handoffDetection:false turns the words off", async () => {
  const agent = "ctguard";
  const mock = makeMockApi({ enabled: true, config: { agents: [agent] } }, { configFile: { commands: { ownerAllowFrom: ["telegram:123"] } } });
  plugin.register(mock.api as never);
  const S = `agent:${agent}:main`;
  const plan = core.createPlan(agent, { title: "Billing migration", steps: ["export", "cut over"] }).plan!;
  // a sender who is not the owner
  await mock.fire("message_received", { content: "Hand the billing migration to Zed.", senderId: "999" }, { agentId: agent, sessionKey: S, sessionId: "g-1", channelId: "telegram" });
  expect(core.getPlan(agent, plan.node_id)!.status).toBe("active");
  // a cron run
  await mock.fire("message_received", { content: "Hand the billing migration to Zed." }, { agentId: agent, sessionKey: `agent:${agent}:cron:11111111-1111-1111-1111-111111111111:run:1`, sessionId: "g-2" });
  expect(core.getPlan(agent, plan.node_id)!.status).toBe("active");
  // the owner
  await mock.fire("message_received", { content: "Hand the billing migration to Zed.", senderId: "123" }, { agentId: agent, sessionKey: S, sessionId: "g-3", channelId: "telegram" });
  expect(core.getPlan(agent, plan.node_id)).toMatchObject({ status: "handed_off", handoff_to: "Zed" });

  const off = "ctoff";
  const mock2 = makeMockApi({ enabled: true, config: { agents: [off], handoffDetection: false } });
  plugin.register(mock2.api as never);
  const p2 = core.createPlan(off, { title: "Billing migration", steps: ["export"] }).plan!;
  await mock2.fire("message_received", { content: "Hand the billing migration to Zed. Let's work on onboarding." }, { agentId: off, sessionKey: `agent:${off}:main`, sessionId: "g-4" });
  expect(core.getPlan(off, p2.node_id)!.status).toBe("active");
  expect(core.getTaskFrame(off, `agent:${off}:main`, core.DEFAULT_CONFIG)).toBeNull();
});

test("local: after_compaction restores the task and the handoff from the summary and leaves a state episode", async () => {
  const agent = "ctcompact";
  const mock = makeMockApi({ enabled: true, config: { agents: [agent] } });
  plugin.register(mock.api as never);
  const S = `agent:${agent}:main`;
  const ctx = { agentId: agent, sessionKey: S, sessionId: "cc-1" };
  const gano = core.setGoal(agent, { title: "Ship the Gano Telegram bot", priority: 1 }).goal!;
  core.createPlan(agent, { title: "Billing migration", steps: ["export invoices", "cut over"] });
  await mock.fire("after_compaction", { compactedCount: 40, messageCount: 60, summary: "The user said the Gano Telegram bot was handed to Mia. Since then we are working on the billing migration; the invoice export is nearly done." }, ctx);
  expect(core.currentGoalRow(agent, gano.lineage_id)).toMatchObject({ status: "handed_off", handoff_to: "Mia" });
  expect(core.getTaskFrame(agent, S, core.DEFAULT_CONFIG)).toMatchObject({ title: "Billing migration", set_by: "compaction" });
  const eps = core.getDb(agent).prepare("SELECT role, content FROM episodes WHERE session_id = ? ORDER BY created_at").all(S) as Array<{ role: string; content: string }>;
  expect(eps.map((e) => e.content)).toEqual([
    "[compaction: 40 of 60 messages compacted]",
    '[session state after compaction] working on: Billing migration (next: 1. export invoices); goal "Ship the Gano Telegram bot" handed off to Mia',
  ]);
  // the session's first prompt build also carries the bootstrap block; the now block follows it
  const p = prependOf(await mock.fire("before_prompt_build", { prompt: "ok continue" }, ctx));
  expect(p).toMatch(/\[BRAIN: now\]\nWorking on: Billing migration \(restored after compaction, just now\)[\s\S]*"ok continue" means the task above/);
  expect(p).not.toMatch(/\[BRAIN: on your mind/);
});
