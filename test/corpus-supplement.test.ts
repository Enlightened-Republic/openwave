// The memory corpus supplement (api.registerMemoryCorpusSupplement) used
// core.agentIdFromKey, whose fallback is the FIRST configured agent: a search
// from a caller it could not identify read main's brain. It now follows the
// same rule as the tools: identify the caller or return nothing.
import { expect, test } from "vitest";
import * as core from "xanima-core";

import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

const A = "cs-a";
const B = "cs-b";

type Supplement = { search: (p: { query: string; maxResults?: number; agentSessionKey?: string }) => Promise<Array<{ id: string; title?: string; corpus: string }>> };

test("local: routes by the caller's session key and refuses an unidentifiable caller instead of reading the first agent", async () => {
  const mock = makeMockApi({ enabled: true, config: { agents: [A, B] } });
  plugin.register(mock.api as never);
  const sup = mock.rec.corpus[0] as Supplement;
  expect(sup).toBeTruthy();

  core.writeNode(A, "semantic", "A only", "The aardvark fact lives in brain A.", { importance: 0.8 });
  core.writeNode(B, "semantic", "B only", "The bandicoot fact lives in brain B.", { importance: 0.8 });

  const fromB = await sup.search({ query: "bandicoot fact", agentSessionKey: `agent:${B}:tg:1` });
  expect(fromB.map((r) => r.title)).toContain("B only");
  expect(fromB.map((r) => r.title)).not.toContain("A only");

  const fromA = await sup.search({ query: "aardvark fact", agentSessionKey: `agent:${A}:tg:1` });
  expect(fromA.map((r) => r.title)).toContain("A only");

  // Unknown caller: nothing, never the first agent's brain.
  expect(await sup.search({ query: "aardvark fact", agentSessionKey: "0f1e2d3c-not-a-session-we-know" })).toEqual([]);
  expect(await sup.search({ query: "aardvark fact" })).toEqual([]);

  // A session id the hooks have seen is enough (hooks record session -> agent).
  await mock.fire("session_start", { sessionId: "cs-sid-1", sessionKey: `agent:${A}:tg:9` }, { agentId: A, sessionId: "cs-sid-1", sessionKey: `agent:${A}:tg:9` });
  const viaId = await sup.search({ query: "aardvark fact", agentSessionKey: "cs-sid-1" });
  expect(viaId.map((r) => r.title)).toContain("A only");
});
