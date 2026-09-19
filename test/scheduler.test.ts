import { afterEach, expect, test, vi } from "vitest";

import * as core from "sharpwave-core";
import { DEFAULT_CONFIG } from "sharpwave-core";
import { armSchedulers, disarmSchedulers, runConsolidationPass } from "../src/scheduler.js";

const noop = { info() {}, warn() {}, error() {} };

afterEach(() => {
  vi.useRealTimers();
});

test("armSchedulers returns replay+sweep; consolidation timers are null (Graft B)", () => {
  vi.useFakeTimers();
  const h = armSchedulers(["sched-a"], DEFAULT_CONFIG, noop);

  expect(h.replay).not.toBeNull();
  expect(h.sweep).not.toBeNull();
  expect(h.consolidation).toBeNull();
  expect(h.initialConsolidation).toBeNull();

  const armed = vi.getTimerCount();
  expect(armed).toBeGreaterThanOrEqual(2);

  disarmSchedulers(h);

  expect(h.replay).toBeNull();
  expect(h.sweep).toBeNull();
  expect(vi.getTimerCount()).toBeLessThanOrEqual(armed - 2);
});

test("disarmSchedulers tolerates a null handle set (cleanup before gateway_start)", () => {
  expect(() => disarmSchedulers(null)).not.toThrow();
  expect(() => disarmSchedulers(undefined)).not.toThrow();
});

test("after disarm, advancing time triggers nothing", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
  const h = armSchedulers(["sched-silent"], DEFAULT_CONFIG, log);
  disarmSchedulers(h);
  lines.length = 0;

  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 2h
  expect(lines).toHaveLength(0);
});

test("Graft B: no in-process hourly consolidation tick after 65 minutes", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
  const h = armSchedulers(["sched-no-hourly"], { ...DEFAULT_CONFIG }, log);

  await vi.advanceTimersByTimeAsync(65 * 60 * 1000);

  const ticks = lines.filter((l) => l.includes('"op":"sleep_system.tick"'));
  expect(ticks).toHaveLength(0);

  disarmSchedulers(h);
});

test("the awake-replay interval runs core.awakeReplayTick without throwing", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
  core.writeNode("sched-replay", "semantic", "seed", "A durable fact.", { importance: 0.6 });
  const h = armSchedulers(["sched-replay"], { ...DEFAULT_CONFIG }, log);

  await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

  expect(lines.find((l) => l.includes('"op":"awake_replay.tick"') && l.includes('"outcome":"error"'))).toBeUndefined();

  disarmSchedulers(h);
});

test("runConsolidationPass logs sleep_system.tick with host_cron trigger", async () => {
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
  runConsolidationPass(["sched-pass"], { ...DEFAULT_CONFIG }, log, "host_cron");
  // Allow the async IIFE to start
  await new Promise((r) => setTimeout(r, 50));
  const tick = lines.find((l) => l.includes('"op":"sleep_system.tick"'));
  expect(tick, `no sleep_system.tick in:\n${lines.join("\n")}`).toBeTruthy();
  expect(tick).toContain('"trigger":"host_cron"');
});
