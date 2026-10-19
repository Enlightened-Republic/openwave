// brain_reset stays registered (manifest contracts.tools) but is refused
// unless the operator set allowAgentReset: the only guard the engine has is
// confirm === the agent's own id, which the agent knows, so a prompt injection
// could otherwise wipe its memory.
import { expect, test } from "vitest";
import * as core from "xanima-core";

import plugin from "../src/index.js";
import { RESET_REFUSED_TEXT } from "../src/reset-guard.js";
import { makeMockApi } from "./mock-api.js";

type Tool = { name: string; execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }>; details: { error?: string } }> };

function setup(agent: string, extra: Record<string, unknown> = {}) {
  const mock = makeMockApi({ enabled: true, config: { agents: [agent], ...extra } });
  plugin.register(mock.api as never);
  const tool = (name: string) => mock.rec.tools.map((f: (c: unknown) => Tool) => f({ agentId: agent, sessionKey: `agent:${agent}:main` })).find((t: Tool) => t.name === name)!;
  return { mock, tool };
}
const count = (agent: string, label: string) =>
  (core.getDb(agent).prepare("SELECT COUNT(*) AS c FROM nodes WHERE label = ?").get(label) as { c: number }).c;

test("default: brain_reset is refused even with the right confirm, and nothing is wiped", async () => {
  const agent = "rg-default";
  const { tool } = setup(agent);
  await tool("brain_write").execute("w", { type: "semantic", label: "keep-me", content: "must survive" });
  expect(count(agent, "keep-me")).toBe(1);

  const r = await tool("brain_reset").execute("r", { confirm: agent });
  expect(r.content[0]!.text).toBe(RESET_REFUSED_TEXT);
  expect(r.details.error).toBe(RESET_REFUSED_TEXT);
  expect(count(agent, "keep-me")).toBe(1);
});

test("allowAgentReset: true hands the call to the engine (its own confirm check still applies)", async () => {
  const agent = "rg-allowed";
  const { tool } = setup(agent, { allowAgentReset: true });
  await tool("brain_write").execute("w", { type: "semantic", label: "wipe-me", content: "gone after reset" });
  expect(count(agent, "wipe-me")).toBe(1);

  const wrong = await tool("brain_reset").execute("r0", { confirm: "someone-else" });
  expect(wrong.content[0]!.text).toMatch(/refused/);
  expect(wrong.content[0]!.text).not.toBe(RESET_REFUSED_TEXT);
  expect(count(agent, "wipe-me")).toBe(1);

  const ok = await tool("brain_reset").execute("r1", { confirm: agent });
  expect(ok.content[0]!.text).not.toBe(RESET_REFUSED_TEXT);
  expect(ok.details.error).toBeUndefined();
  expect(count(agent, "wipe-me")).toBe(0);
});
