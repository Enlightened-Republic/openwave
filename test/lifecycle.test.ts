import { afterEach, expect, test, vi } from "vitest";

import * as core from "xanima-core";
import { getDb } from "xanima-core";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

afterEach(() => {
  vi.useRealTimers();
});

const BOOTSTRAP_MARKER = "[Xanima active]";
const prependOf = (out: unknown[]) =>
  (out.find((r) => (r as { prependContext?: string })?.prependContext) as { prependContext?: string })?.prependContext ?? "";

test("restart: DB handle stays open, scheduler timers released", async () => {
  vi.useFakeTimers();
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["lc-restart"] } });
  plugin.register(api as never);

  // gateway_start arms the scheduler (3 in-process timers post-Graft B: replay + harvest + sweep).
  await Promise.all((rec.hooks.get("gateway_start") ?? []).map((h) => h({}, {})));
  const armed = vi.getTimerCount();
  expect(armed).toBeGreaterThanOrEqual(3);

  getDb("lc-restart").prepare("SELECT 1").get();
  const lc = rec.lifecycles[0];

  await lc.cleanup({ reason: "restart" });

  // Scheduler handles cleared — the three in-process timers are gone.
  expect(vi.getTimerCount()).toBeLessThanOrEqual(armed - 3);
  // 2026-05-16 incident guard: restart must NOT close DB handles.
  expect(() => getDb("lc-restart").prepare("SELECT 1").get()).not.toThrow();
});

test("restart without a new gateway_start: the next turn re-arms the timers; gateway_stop does not", async () => {
  const lines: string[] = [];
  const { api, rec, fire } = makeMockApi({ enabled: true, config: { agents: ["lc-rearm"] } });
  (api as { logger: unknown }).logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {}, debug() {} };
  plugin.register(api as never);
  const ctx = { agentId: "lc-rearm", sessionKey: "agent:lc-rearm:main", sessionId: "s-lc-rearm" };
  const rearmed = () => lines.filter((l) => l.includes('"op":"sleep_system"') && l.includes('"outcome":"rearmed"')).length;

  await fire("gateway_start", {}, {});
  await fire("before_prompt_build", { prompt: "hi" }, ctx);
  expect(rearmed()).toBe(0); // armed by gateway_start: nothing to do

  await rec.lifecycles[0].cleanup({ reason: "restart" });
  await fire("before_prompt_build", { prompt: "hi again" }, ctx);
  expect(rearmed()).toBe(1);
  await fire("before_prompt_build", { prompt: "and again" }, ctx);
  expect(rearmed()).toBe(1); // armed once, not per turn

  await fire("gateway_stop", {}, {});
  await fire("before_prompt_build", { prompt: "after stop" }, ctx);
  expect(rearmed()).toBe(1); // a stopped gateway never re-arms
});

test("restart keeps per-session bookkeeping: a live session is not handed its bootstrap a second time (reset still drops it)", async () => {
  const { api, rec, fire } = makeMockApi({ enabled: true, config: { agents: ["lc-boot"] } });
  plugin.register(api as never);
  core.writeNode("lc-boot", "semantic", "db", "Production uses PostgreSQL 16.", { importance: 0.8 });
  const ctx = { agentId: "lc-boot", sessionKey: "agent:lc-boot:tg:1", sessionId: "s-lc-boot" };

  await fire("session_start", { ...ctx }, ctx);
  const key = rec.injections[0].idempotencyKey;
  await fire("agent_turn_prepare", { queuedInjections: [{ idempotencyKey: key }] }, ctx); // host delivered it
  expect(prependOf(await fire("before_prompt_build", { prompt: "what database?" }, ctx))).not.toContain(BOOTSTRAP_MARKER);

  await rec.lifecycles[0].cleanup({ reason: "restart" });
  expect(prependOf(await fire("before_prompt_build", { prompt: "what database?" }, ctx))).not.toContain(BOOTSTRAP_MARKER);

  // reset tears durable plugin state down, so the session starts over and gets its bootstrap again.
  await rec.lifecycles[0].cleanup({ reason: "reset" });
  expect(prependOf(await fire("before_prompt_build", { prompt: "what database?" }, ctx))).toContain(BOOTSTRAP_MARKER);
});

test("reset: cleanup runs, closeAllDbs fires, getDb reopens with the schema intact", async () => {
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["lc-reset"] } });
  plugin.register(api as never);

  getDb("lc-reset").prepare("SELECT 1").get();
  const lc = rec.lifecycles[0];

  await lc.cleanup({ reason: "reset" });

  // closeAllDbs ran inside cleanup; getDb must reopen the file lazily and it
  // must be uncorrupted — assert the reopen path, not a tautology.
  const row = getDb("lc-reset").prepare("SELECT 1 AS ok").get() as { ok: number };
  expect(row.ok).toBe(1);
  const nodeCount = getDb("lc-reset").prepare("SELECT count(*) AS n FROM nodes").get() as { n: number };
  expect(nodeCount.n).toBeGreaterThanOrEqual(0);
});

test("cleanup on an unknown/restart reason before any gateway_start does not throw", async () => {
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["lc-noarm"] } });
  plugin.register(api as never);
  const lc = rec.lifecycles[0];

  await expect(lc.cleanup({ reason: "restart" })).resolves.not.toThrow();
});
