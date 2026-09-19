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
