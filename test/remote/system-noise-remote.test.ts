// Remote mode against a REAL sharpwave-server (built from sharpwave main):
// system turns produce no episode (brain_episode_append is never called for
// them) and no fact (the session_end harvest's brain_write never sees them).
// A control run with skipSystemTurns:false proves the same scenario pollutes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import plugin, { __remoteRuntimeForTests } from "../../src/index.js";
import { makeMockApi } from "../mock-api.js";
import { HAVE_SERVER, startServer, type RunningServer } from "./server-harness.js";
import { KEPT_CONTENTS, NOISE_NEEDLES, runNoiseScenario } from "../fixtures/noise-scenario.js";

function read<T>(svc: RunningServer, brain: string, sql: string): T[] {
  const path = join(svc.root, "brains", brain, "brain.db");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
}

async function scenario(svc: RunningServer, agent: string, extra: Record<string, unknown>) {
  const m = makeMockApi({ enabled: true, config: { agents: [agent], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token"), llmExtractionEnabled: true, ...extra } });
  plugin.register(m.api as never);
  const rt = __remoteRuntimeForTests()!;
  try {
    await m.fire("gateway_start", {}, {});
    await rt.startupCheck;
    await runNoiseScenario(m.fire, agent);
    // session_end on the chat session drains the extraction queue → brain_write.
    const chat = { agentId: agent, sessionKey: `agent:${agent}:telegram:direct:42`, sessionId: "sess-chat" };
    await m.fire("session_end", { sessionId: chat.sessionId, sessionKey: chat.sessionKey }, chat);
    await rt.flushEpisodes();
    return {
      skipped: rt.noiseSkipped(),
      episodes: read<{ role: string; content: string; session_id: string }>(svc, agent, "SELECT role, content, session_id FROM episodes ORDER BY created_at, rowid"),
      nodes: read<{ content: string; source: string }>(svc, agent, "SELECT content, source FROM nodes"),
    };
  } finally {
    await rt.stop();
  }
}

describe.skipIf(!HAVE_SERVER)("remote mode system-noise gate (real sharpwave-server)", () => {
  let svc: RunningServer;
  beforeAll(async () => {
    svc = await startServer();
    for (const a of ["ow-noise-remote", "ow-noise-remote-off"]) svc.writeTokenFile(a, svc.mint(a, ["read", "write"]));
  }, 30_000);
  afterAll(async () => { await svc?.stop(); });

  test("skipped turns produce no episodes and no facts on the service", async () => {
    const r = await scenario(svc, "ow-noise-remote", {});
    expect(r.skipped).toBeGreaterThanOrEqual(10);
    expect(r.episodes.filter((e) => e.role !== "tool").map((e) => e.content)).toEqual(KEPT_CONTENTS);
    expect(r.episodes.some((e) => e.session_id.endsWith(":heartbeat"))).toBe(false);
    const all = JSON.stringify(r);
    for (const n of NOISE_NEEDLES) expect(all).not.toContain(n);
    // The harvest did write facts — only from conversation.
    expect(r.nodes.length).toBeGreaterThan(0);
    expect(r.nodes.some((n) => /heartbeat monitor scratch|Saved today.s notes|^\s*NO_REPLY|HEARTBEAT_OK/.test(n.content))).toBe(false);
  }, 30_000);

  test("control: skipSystemTurns=false sends the same noise to the service", async () => {
    const r = await scenario(svc, "ow-noise-remote-off", { skipSystemTurns: false });
    expect(r.skipped).toBe(0); // the client sent everything
    const eps = JSON.stringify(r.episodes);
    // sharpwave main stores the noise; a server with its own guard (sharpwave
    // engram/skip-heartbeat-noise) answers "Skipped: system-noise" and audits it.
    const auditPath = join(svc.root, "audit", "audit.jsonl");
    const serverGuarded = existsSync(auditPath) && readFileSync(auditPath, "utf8").includes("skipped system-noise");
    if (serverGuarded) {
      expect(eps).not.toContain("NO_REPLY — 3:12 PM");
    } else {
      expect(eps).toContain("[OpenClaw heartbeat poll]");
      expect(eps).toContain("NO_REPLY — 3:12 PM");
      expect(r.nodes.some((n) => /heartbeat monitor scratch|Saved today.s notes|^\s*NO_REPLY/.test(n.content))).toBe(true);
    }
  }, 30_000);
});

test.skipIf(HAVE_SERVER)("remote system-noise suite needs SHARPWAVE_SERVER_CLI", () => {});
