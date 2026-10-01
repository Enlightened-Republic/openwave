// Remote mode episode writes via brain_episode_append, feature-detected from
// the service's tool list. Runs against SHARPWAVE_SERVER_CLI and, if set,
// SHARPWAVE_SERVER_CLI_LEGACY (an older build without the tool → fallback).
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import plugin, { __remoteRuntimeForTests } from "../../src/index.js";
import { makeMockApi } from "../mock-api.js";
import { HAVE_SERVER, LEGACY_SERVER_CLI, SERVER_CLI, startServer, type RunningServer } from "./server-harness.js";

async function advertised(url: string, token: string): Promise<string[]> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((t) => t.name);
}

function setup(svc: RunningServer, agentId: string) {
  const m = makeMockApi({ enabled: true, config: { agents: [agentId], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token") } });
  const logs: string[] = [];
  (m.api as { logger: unknown }).logger = { info: (s: string) => logs.push(s), warn: (s: string) => logs.push(s), error: (s: string) => logs.push(s), debug() {} };
  plugin.register(m.api as never);
  return { ...m, logs, runtime: __remoteRuntimeForTests()! };
}

function serverEpisodes(svc: RunningServer, brain: string): Array<{ session_id: string; role: string; content: string; writer_agent_id: string; importance: number }> {
  const path = join(svc.root, "brains", brain, "brain.db");
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT session_id, role, content, writer_agent_id, importance FROM episodes ORDER BY created_at, rowid").all() as never;
  } finally {
    db.close();
  }
}

const builds: Array<[string, string]> = HAVE_SERVER ? [["primary", SERVER_CLI]] : [];
if (LEGACY_SERVER_CLI && existsSync(LEGACY_SERVER_CLI)) builds.push(["legacy", LEGACY_SERVER_CLI]);

for (const [label, cli] of builds) {
  describe(`remote episodes (${label} server: ${cli})`, () => {
    let svc: RunningServer;
    let supported = false;
    const agent = `ow-ep-${label}`;

    beforeAll(async () => {
      svc = await startServer(cli);
      const tok = svc.mint(agent, ["read", "write"]);
      svc.writeTokenFile(agent, tok);
      supported = (await advertised(svc.url, tok)).includes("brain_episode_append");
      // OPENWAVE_EXPECT_EPISODE_APPEND=1 pins the primary build to the new tool (CI/handoff runs).
      if (label === "primary" && process.env["OPENWAVE_EXPECT_EPISODE_APPEND"] === "1" && !supported) {
        throw new Error(`${cli} does not advertise brain_episode_append`);
      }
      if (label === "legacy" && supported) throw new Error(`legacy build ${cli} unexpectedly advertises brain_episode_append`);
    }, 30_000);
    afterAll(async () => { await svc?.stop(); });

    test("conversation turns, session markers and compaction markers reach the service iff it advertises brain_episode_append", async () => {
      const h = setup(svc, agent);
      try {
        const ctx = { agentId: agent, sessionKey: `agent:${agent}:telegram:42`, sessionId: "sess-42" };
        await h.fire("gateway_start", {}, {});
        await h.runtime.startupCheck;
        await h.fire("session_start", { sessionId: "sess-42", sessionKey: ctx.sessionKey }, ctx);
        await h.fire("message_received", { content: "Remember the cassowary feeding schedule is at 7am" }, ctx);
        await h.fire("llm_output", { assistantTexts: ["[[reply_to_current]] Noted: cassowary feeding at 7am."] }, ctx);
        await h.fire("after_compaction", { compactedCount: 3, messageCount: 9 }, ctx);
        await h.fire("session_end", { sessionId: "sess-42", sessionKey: ctx.sessionKey }, ctx);
        await h.runtime.flushEpisodes();
        const info = (await h.callAction("getBrainConnection", {})).result;
        const rows = serverEpisodes(svc, agent);

        if (supported) {
          expect(info.episodeAppend).toBe(true);
          expect(h.logs.some((l) => l.includes('"op":"remote.episode_append","outcome":"enabled"'))).toBe(true);
          expect(rows.map((r) => [r.role, r.content])).toEqual([
            ["tool", `[session start: ${ctx.sessionKey}]`],
            ["user", "Remember the cassowary feeding schedule is at 7am"],
            ["assistant", "Noted: cassowary feeding at 7am."], // control directives stripped, as locally
            ["tool", "[compaction: 3 of 9 messages compacted]"],
            ["tool", `[session end: ${ctx.sessionKey}]`],
          ]);
          expect(rows.every((r) => r.writer_agent_id === agent && r.session_id === ctx.sessionKey)).toBe(true);
          expect(rows[1]!.importance).toBeCloseTo(0.85); // same heuristic score as local
          // Readable back through the proxied tool surface.
          const tool = h.rec.tools.map((f: (c: unknown) => { name: string }) => f({ agentId: agent })).find((t: { name: string }) => t.name === "brain_history") as { execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }> };
          const hist = (await tool.execute("x", { query: "cassowary" })).content[0]!.text;
          expect(hist).toContain("cassowary feeding");
          expect(hist).toContain(`writer=${agent}`);
        } else {
          // Fallback: previous behaviour — nothing stored, nothing thrown, logged once.
          expect(info.episodeAppend).toBe(false);
          expect(rows).toEqual([]);
          expect(h.logs.filter((l) => l.includes('"outcome":"unsupported"')).length).toBe(1);
        }
        // Never registered as a model-facing tool.
        expect(h.rec.tools.map((f: (c: unknown) => { name: string }) => f({ agentId: agent }).name)).not.toContain("brain_episode_append");
      } finally {
        await h.runtime.stop();
      }
    });
  });
}

test.skipIf(builds.length > 0)("remote episode suites need SHARPWAVE_SERVER_CLI", () => {});
