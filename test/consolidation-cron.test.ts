import { expect, test, vi } from "vitest";

import plugin from "../src/index.js";
import { CONSOLIDATION_WAKE_MODE } from "../src/engram-graft.js";
import { makeMockApi } from "./mock-api.js";

test("gateway_start registers openwave:consolidation host cron (Graft B) that never wakes the agent", async () => {
  const added: unknown[] = [];
  const cron = {
    list: vi.fn(async () => []),
    add: vi.fn(async (input: unknown) => {
      added.push(input);
      return { id: "openwave:consolidation" };
    }),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({ removed: true })),
  };

  const mock = makeMockApi({
    enabled: true,
    config: {
      agents: ["main"],
      consolidationCron: "30 4 * * *",
      consolidationCronEnabled: true,
    },
  });
  plugin.register(mock.api as never);

  await mock.fire("gateway_start", {}, { getCron: () => cron });

  expect(cron.list).toHaveBeenCalled();
  expect(cron.add).toHaveBeenCalled();
  const job = added[0] as { name?: string; wakeMode?: string; sessionTarget?: string; payload?: { kind?: string }; schedule?: { expr?: string; kind?: string } };
  expect(job.name).toBe("openwave:consolidation");
  expect(job.schedule?.expr).toBe("30 4 * * *");
  expect(job.schedule?.kind).toBe("cron");
  // A main-session systemEvent job with wakeMode "now" is agent work on
  // OpenClaw (it requests an immediate heartbeat = an LLM turn every night).
  expect(job.payload?.kind).toBe("systemEvent");
  expect(job.wakeMode).toBe(CONSOLIDATION_WAKE_MODE);
  expect(job.wakeMode).not.toBe("now");
});

test("an existing job left with wakeMode now by an older version is switched in place, not re-added", async () => {
  const cron = {
    list: vi.fn(async () => [{ id: "openwave:consolidation", name: "openwave:consolidation", wakeMode: "now" }]),
    add: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({ removed: true })),
  };
  const mock = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(mock.api as never);
  await mock.fire("gateway_start", {}, { getCron: () => cron });
  expect(cron.add).not.toHaveBeenCalled();
  expect(cron.update).toHaveBeenCalledWith("openwave:consolidation", { wakeMode: CONSOLIDATION_WAKE_MODE });
});

test("gateway_start skips consolidation cron when consolidationCronEnabled=false", async () => {
  const cron = {
    list: vi.fn(async () => []),
    add: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({ removed: true })),
  };
  const mock = makeMockApi({
    enabled: true,
    config: { agents: ["main"], consolidationCronEnabled: false },
  });
  plugin.register(mock.api as never);
  await mock.fire("gateway_start", {}, { getCron: () => cron });
  expect(cron.add).not.toHaveBeenCalled();
});

test("gateway_start legacy cleanup never removes openwave:consolidation; existing job is not re-added or updated", async () => {
  const cron = {
    list: vi.fn(async () => [{ id: "openwave:consolidation", name: "openwave:consolidation", wakeMode: CONSOLIDATION_WAKE_MODE }, { id: "clawbrain-v4:sws", name: "clawbrain-v4:sws" }]),
    add: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({ removed: true })),
  };
  const mock = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(mock.api as never);
  await mock.fire("gateway_start", {}, { getCron: () => cron });
  expect(cron.remove).toHaveBeenCalledWith("clawbrain-v4:sws");
  expect(cron.remove).not.toHaveBeenCalledWith("openwave:consolidation");
  expect(cron.add).not.toHaveBeenCalled();
  expect(cron.update).not.toHaveBeenCalled();
});

test("cron_changed: only a FINISHED ok run of openwave:consolidation runs the pass in-process, exactly once", async () => {
  const lines: string[] = [];
  const mock = makeMockApi({ enabled: true, config: { agents: ["cron-pass"] } });
  (mock.api as { logger: unknown }).logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {}, debug() {} };
  plugin.register(mock.api as never);
  const ticks = () => lines.filter((l) => l.includes('"op":"sleep_system.tick"') && l.includes('"agentId":"cron-pass"'));
  const settle = () => new Promise((r) => setTimeout(r, 80));

  // OpenClaw emits started (status running) THEN finished (status ok) for one
  // firing; the old "looks like a fire" regex matched both and ran the pass twice.
  await mock.fire("cron_changed", { action: "started", status: "running", jobId: "openwave:consolidation" }, {});
  await settle();
  expect(ticks()).toHaveLength(0);

  await mock.fire("cron_changed", { action: "finished", status: "ok", jobId: "openwave:consolidation" }, {});
  await settle();
  expect(ticks(), `no sleep_system.tick in:\n${lines.join("\n")}`).toHaveLength(1);
  expect(ticks()[0]).toContain('"trigger":"host_cron"');

  // A failed or skipped run, an add/update/remove, and other jobs never trigger a pass.
  for (const evt of [
    { action: "finished", status: "error", jobId: "openwave:consolidation" },
    { action: "finished", status: "skipped", jobId: "openwave:consolidation" },
    { action: "added", jobId: "openwave:consolidation" },
    { action: "updated", jobId: "openwave:consolidation" },
    { action: "removed", jobId: "openwave:consolidation" },
    { action: "finished", status: "ok", jobId: "clawbrain-v4:rem" },
    { action: "finished", status: "ok", jobId: "someone-else:job" },
  ]) {
    await mock.fire("cron_changed", evt, {});
  }
  await settle();
  expect(ticks()).toHaveLength(1);

  // An older host that sends a bare event for our job still counts as a fire.
  await mock.fire("cron_changed", { jobId: "openwave:consolidation" }, {});
  await settle();
  expect(ticks()).toHaveLength(2);
});
