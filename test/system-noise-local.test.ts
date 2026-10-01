// Local mode: system turns never reach the episode log or the LLM-extraction
// queue (so neither the hourly/session_end harvest nor in-process SWS can mint
// nodes from them). Control run with skipSystemTurns:false proves the scenario
// would otherwise pollute.
import { describe, expect, test } from "vitest";
import * as core from "sharpwave-core";

import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";
import { KEPT_CONTENTS, NOISE_NEEDLES, runNoiseScenario } from "./fixtures/noise-scenario.js";

const quiet = { info() {}, warn() {}, error() {} };

function episodes(agent: string): Array<{ role: string; content: string; session_id: string }> {
  return core.getDb(agent).prepare("SELECT role, content, session_id FROM episodes ORDER BY created_at, rowid").all() as never;
}

async function run(agent: string, extra: Record<string, unknown>) {
  const m = makeMockApi({ enabled: true, config: { agents: [agent], llmExtractionEnabled: true, ...extra } });
  plugin.register(m.api as never);
  await runNoiseScenario(m.fire, agent);
  const drained = await core.drainExtractionQueue(agent, { ...core.DEFAULT_CONFIG, llmExtractionEnabled: true, llmExtractionMinImportance: 0 }, quiet);
  return { rows: episodes(agent), drained };
}

describe("local mode system-noise gate", () => {
  test("default: only conversation is appended and queued", async () => {
    const agent = `ow-noise-local-${Date.now()}`;
    const { rows, drained } = await run(agent, {});
    const contents = rows.filter((r) => r.role !== "tool").map((r) => r.content);
    expect(contents).toEqual(KEPT_CONTENTS);
    // No session markers for the isolated heartbeat session.
    expect(rows.some((r) => r.session_id.endsWith(":heartbeat"))).toBe(false);
    const all = JSON.stringify(rows);
    for (const n of NOISE_NEEDLES) expect(all).not.toContain(n);
    // The extraction queue only held conversation episodes.
    const keptIds = new Set((core.getDb(agent).prepare("SELECT id FROM episodes WHERE role != 'tool'").all() as Array<{ id: string }>).map((r) => r.id));
    expect(drained.episodeIds.length).toBeGreaterThan(0);
    for (const id of drained.episodeIds) expect(keptIds.has(id)).toBe(true);
    expect(JSON.stringify(drained)).not.toMatch(/NO_REPLY —|HEARTBEAT_OK|owner-blocked/);
    // In-process SWS over this log cannot produce a triage node.
    await core.runConsolidation(agent, core.DEFAULT_CONFIG, quiet);
    const nodes = core.getDb(agent).prepare("SELECT content FROM nodes").all() as Array<{ content: string }>;
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some((n) => /^\s*NO_REPLY|HEARTBEAT_OK|owner-blocked|\[OpenClaw |heartbeat monitor scratch|Saved today.s notes|build finished/.test(n.content))).toBe(false);
  });

  test("control: skipSystemTurns=false stores the noise (scenario is sensitive)", async () => {
    const agent = `ow-noise-local-off-${Date.now()}`;
    const { rows, drained } = await run(agent, { skipSystemTurns: false });
    const all = JSON.stringify(rows);
    expect(all).toContain("[OpenClaw heartbeat poll]");
    expect(all).toContain("NO_REPLY — 3:12 PM");
    expect(rows.some((r) => r.session_id.endsWith(":heartbeat"))).toBe(true);
    expect(JSON.stringify(drained)).toMatch(/owner-blocked|NO_REPLY/);
    // ...and the session_end harvest / SWS mint nodes from it (heuristic extractor, no LLM key).
    await core.runConsolidation(agent, core.DEFAULT_CONFIG, quiet);
    const nodes = core.getDb(agent).prepare("SELECT content, source FROM nodes").all() as Array<{ content: string; source: string }>;
    expect(nodes.some((n) => /heartbeat monitor scratch|^\s*NO_REPLY —|Saved today's notes/.test(n.content))).toBe(true);
  });

  test("systemTurnPatterns adds operator patterns", async () => {
    const agent = `ow-noise-local-pat-${Date.now()}`;
    const m = makeMockApi({ enabled: true, config: { agents: [agent], systemTurnPatterns: ["^\\[cron triage\\]"] } });
    plugin.register(m.api as never);
    const ctx = { agentId: agent, sessionKey: `agent:${agent}:main`, sessionId: "s" };
    await m.fire("message_received", { content: "[cron triage] 3 jobs queued" }, ctx);
    await m.fire("message_received", { content: "please look at the cron triage doc" }, ctx);
    expect(episodes(agent).map((r) => r.content)).toEqual(["please look at the cron triage doc"]);
  });
});
