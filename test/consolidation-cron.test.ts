import { expect, test, vi } from "vitest";

import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

test("gateway_start registers openwave:consolidation host cron (Graft B)", async () => {
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
  const job = added[0] as { name?: string; schedule?: { expr?: string; kind?: string } };
  expect(job.name).toBe("openwave:consolidation");
  expect(job.schedule?.expr).toBe("30 4 * * *");
  expect(job.schedule?.kind).toBe("cron");
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

test("gateway_start legacy cleanup never removes openwave:consolidation; existing job is not re-added", async () => {
  const cron = {
    list: vi.fn(async () => [{ id: "openwave:consolidation", name: "openwave:consolidation" }, { id: "clawbrain-v4:sws", name: "clawbrain-v4:sws" }]),
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
});

test("cron_changed for openwave:consolidation runs the consolidation pass in-process (host_cron trigger)", async () => {
  const lines: string[] = [];
  const mock = makeMockApi({ enabled: true, config: { agents: ["cron-pass"] } });
  (mock.api as { logger: unknown }).logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {}, debug() {} };
  plugin.register(mock.api as never);

  await mock.fire("cron_changed", { action: "finished", status: "ok", jobId: "openwave:consolidation" }, {});
  await new Promise((r) => setTimeout(r, 50));

  const tick = lines.find((l) => l.includes('"op":"sleep_system.tick"') && l.includes('"agentId":"cron-pass"'));
  expect(tick, `no sleep_system.tick in:\n${lines.join("\n")}`).toBeTruthy();
  expect(tick).toContain('"trigger":"host_cron"');

  // Legacy / unrelated job events never trigger a pass.
  lines.length = 0;
  await mock.fire("cron_changed", { action: "finished", status: "ok", jobId: "clawbrain-v4:rem" }, {});
  await mock.fire("cron_changed", { action: "finished", status: "ok", jobId: "someone-else:job" }, {});
  await new Promise((r) => setTimeout(r, 50));
  expect(lines.find((l) => l.includes('"op":"sleep_system.tick"'))).toBeUndefined();
});
