// Persona overrides (Control UI, personaOverrides.<agentId>) must reach the
// engine. Until this test existed they were persisted by the session actions
// and never read on any engine path, so the settings page changed nothing.
import { expect, test, vi } from "vitest";

const seen = vi.hoisted(() => [] as Array<{ fn: string; agentId: string; config: Record<string, unknown> }>);

vi.mock("xanima-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xanima-core")>();
  return {
    ...actual,
    buildSelfModelHeader: async (agentId: string, config: Record<string, unknown>, ...rest: unknown[]) => {
      seen.push({ fn: "buildSelfModelHeader", agentId, config });
      return (actual.buildSelfModelHeader as unknown as (...a: unknown[]) => Promise<string>)(agentId, config, ...rest);
    },
    dispatchBrainTool: async (name: string, agentId: string, args: Record<string, unknown>, config: Record<string, unknown>, prov: string) => {
      seen.push({ fn: `tool:${name}`, agentId, config });
      return (actual.dispatchBrainTool as unknown as (...a: unknown[]) => Promise<{ text: string; isError: boolean }>)(name, agentId, args, config, prov);
    },
  };
});

import plugin, { applyPersonaOverrides } from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

const last = (fn: string, agentId: string) => [...seen].reverse().find((s) => s.fn === fn && s.agentId === agentId)?.config;

test("applyPersonaOverrides: numeric override fields replace the flat values for that agent only", () => {
  const base = { contextBudget: 2000, pruneAfterDays: 90, personaOverrides: { mila: { contextBudget: 1234, pruneAfterDays: Number.NaN, emotionalProfile: { valenceBias: 0.2 } } } } as never;
  expect(applyPersonaOverrides(base, "algen")).toBe(base); // no override: the flat config object itself
  const mila = applyPersonaOverrides(base, "mila") as unknown as Record<string, unknown>;
  expect(mila["contextBudget"]).toBe(1234);
  expect(mila["pruneAfterDays"]).toBe(90); // NaN is ignored
  expect((base as unknown as Record<string, unknown>)["contextBudget"]).toBe(2000); // flat config untouched
});

test("a saved override changes the config the engine receives on hooks for that agent, not for others; clearing restores it", async () => {
  const { api, fire, callAction } = makeMockApi({ enabled: true, config: { agents: ["mila", "algen"], contextBudget: 2000, pruneAfterDays: 90 } });
  plugin.register(api as never);
  const ctx = (agentId: string) => ({ agentId, sessionKey: `agent:${agentId}:main`, sessionId: `s-${agentId}` });

  await fire("before_prompt_build", { prompt: "hello" }, ctx("mila"));
  expect(last("buildSelfModelHeader", "mila")?.["contextBudget"]).toBe(2000);

  await callAction("setPersonaOverride", { agentId: "mila", patch: { contextBudget: 1234, pruneAfterDays: 7 } });

  await fire("before_prompt_build", { prompt: "hello again" }, ctx("mila"));
  await fire("before_prompt_build", { prompt: "hello" }, ctx("algen"));
  expect(last("buildSelfModelHeader", "mila")?.["contextBudget"]).toBe(1234);
  expect(last("buildSelfModelHeader", "mila")?.["pruneAfterDays"]).toBe(7);
  expect(last("buildSelfModelHeader", "algen")?.["contextBudget"]).toBe(2000);
  expect(last("buildSelfModelHeader", "algen")?.["pruneAfterDays"]).toBe(90);

  // Heartbeat header path too.
  await fire("heartbeat_prompt_contribution", {}, { agentId: "mila", sessionKey: "agent:mila:main" });
  expect(last("buildSelfModelHeader", "mila")?.["contextBudget"]).toBe(1234);

  // Clearing the override restores the flat value on the next call.
  await callAction("clearPersonaOverride", { agentId: "mila" });
  await fire("before_prompt_build", { prompt: "and now" }, ctx("mila"));
  expect(last("buildSelfModelHeader", "mila")?.["contextBudget"]).toBe(2000);
});

test("brain_* tools dispatch with the calling agent's effective config", async () => {
  const mock = makeMockApi({ enabled: true, config: { agents: ["tp-a", "tp-b"], pruneAfterDays: 90 } });
  plugin.register(mock.api as never);
  await mock.callAction("setPersonaOverride", { agentId: "tp-a", patch: { pruneAfterDays: 3 } });
  type Tool = { name: string; execute: (id: string, p: unknown) => Promise<unknown> };
  const tool = (name: string, agentId: string) => mock.rec.tools.map((f: (c: unknown) => Tool) => f({ agentId })).find((t: Tool) => t.name === name)!;
  await tool("brain_stats", "tp-a").execute("c1", {});
  await tool("brain_stats", "tp-b").execute("c2", {});
  expect(last("tool:brain_stats", "tp-a")?.["pruneAfterDays"]).toBe(3);
  expect(last("tool:brain_stats", "tp-b")?.["pruneAfterDays"]).toBe(90);
});
