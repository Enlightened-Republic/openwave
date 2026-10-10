// Unit tests: roster resolution, exclusion, token-file writing, provisioner backoff/misconfig.
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AgentRoster, Provisioner, listConfiguredAgents, validAgentId, writeTokenFileSecure, isDynamicAgents } from "../../src/remote/agents.js";

const fmt = (f: Record<string, unknown>) => JSON.stringify(f);
const quiet = () => { const logs: string[] = []; return { logs, log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) } }; };

describe("roster", () => {
  test("reads agents.list and agents.entries; legacy config = main", () => {
    expect(listConfiguredAgents({ agents: { list: [{ id: "main", identity: { name: "Tripp" } }, { id: "Gano", name: "Gano" }, null] } }))
      .toEqual([{ id: "main", name: "Tripp" }, { id: "gano", name: "Gano" }]);
    expect(listConfiguredAgents({ agents: { entries: { neva: { name: "Neva" }, wren: {} } } })).toEqual([{ id: "neva", name: "Neva" }, { id: "wren" }]);
    expect(listConfiguredAgents({})).toEqual([{ id: "main" }]);
    expect(listConfiguredAgents({ agents: { list: [] } })).toEqual([]);
  });

  test('agents:"*" is live (re-reads config), excludeAgents applies, invalid ids dropped', () => {
    const cfg: { agents: { list: Array<{ id: string }> } } = { agents: { list: [{ id: "main" }, { id: "neva" }, { id: "shared" }, { id: "../x" }] } };
    const r = new AgentRoster({ agents: "*", excludeAgents: ["Neva"] }, () => cfg);
    expect(r.ids()).toEqual(["main"]);
    cfg.agents.list.push({ id: "gano" });
    expect(r.has("gano")).toBe(true);
    expect(r.has("neva")).toBe(false);
  });

  test("explicit list is unchanged (ignores OpenClaw config), exclude still applies", () => {
    const r = new AgentRoster({ agents: ["main", "gion"] }, () => ({ agents: { list: [{ id: "gano" }] } }));
    expect(r.dynamic).toBe(false);
    expect(r.ids()).toEqual(["main", "gion"]);
    expect(new AgentRoster({ agents: ["main", "gion"], excludeAgents: ["gion"] }, () => ({})).ids()).toEqual(["main"]);
    expect(isDynamicAgents({ autoAgents: true })).toBe(true);
    expect(validAgentId("gano")).toBe(true);
    expect(validAgentId("audit")).toBe(false);
  });
});

describe("token file + provisioner", () => {
  test("writeTokenFileSecure is atomic and owner-only (POSIX)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-tok-"));
    const p = join(dir, "sub", "gano.token");
    writeTokenFileSecure(p, "swt_abc");
    expect(readFileSync(p, "utf8")).toBe("swt_abc\n");
    if (process.platform !== "win32") expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("misconfigured provisioner: clear errors, no throw, no token file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-tok-"));
    const q = quiet();
    const p1 = new Provisioner({ autoProvision: true, brainTokenFile: join(dir, "{agentId}.token") }, "http://127.0.0.1:1", 500, q.log, fmt);
    const r1 = await p1.ensure("gano");
    expect(r1).toMatchObject({ status: "error", error: expect.stringContaining("provisionTokenFile") });
    const p2 = new Provisioner({ autoProvision: true, brainTokenFile: join(dir, "single.token"), provisionTokenFile: "x" }, "http://127.0.0.1:1", 500, q.log, fmt);
    expect(await p2.ensure("gano")).toMatchObject({ status: "error", error: expect.stringContaining("{agentId}") });
    expect(existsSync(join(dir, "gano.token"))).toBe(false);
  });

  test("service down: error is retryable, backs off, never logs the provisioner token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ow-tok-"));
    const pt = join(dir, "_provisioner.token");
    writeTokenFileSecure(pt, "swt_PROVISIONERSECRET");
    const q = quiet();
    let now = 1_000_000;
    const p = new Provisioner({ autoProvision: true, brainTokenFile: join(dir, "{agentId}.token"), provisionTokenFile: pt }, "http://127.0.0.1:1", 300, q.log, fmt, () => now);
    const r = await p.ensure("gano");
    expect(r).toMatchObject({ status: "error", retryable: true });
    const r2 = await p.ensure("gano");
    expect(r2).toMatchObject({ status: "error", error: expect.stringContaining("backing off") });
    now += 3_000;
    expect((await p.ensure("gano")).status).toBe("error");
    expect(q.logs.join("\n")).not.toContain("PROVISIONERSECRET");
    await p.close();
  });
});
