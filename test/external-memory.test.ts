import { afterAll, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "sharpwave-core";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

// When the host already curates MEMORY.md/USER.md (OpenClaw memory-core), openwave
// must stop injecting the goals block -- that tier owns curated goals. Everything
// else graph-specific (BRAIN_HEADER, the SharpWave identity header, recall) must
// stay. sharpwave-core >= 0.4.2 takes the `externalMemoryActive` option; openwave
// decides it per agent from the agent's workspace.
//
// We assert on the goals block's own rendering, not on the goal's text: the node's
// content can legitimately surface elsewhere in the bootstrap through recall.
//   bootstrap:       "[BRAIN: active goals]" + "• <label>" lines
//   every-turn head: "[goals] <label> · <label>"
// A dedicated agent id keeps other test files' goals out of the header's top-3.

const AGENT = "extmem";
const LABEL = "extmem-wiring-goal";
const BOOTSTRAP_GOALS = `• ${LABEL}`;
const HEADER_GOALS = `[goals] ${LABEL}`;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ow-ws-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function register(workspaceDir?: string) {
  const mock = makeMockApi({ enabled: true, config: { agents: [AGENT] } }, workspaceDir === undefined ? {} : { workspaceDir });
  plugin.register(mock.api as never);
  core.writeNode(AGENT, "goal", LABEL, "Ship the external-memory wiring.", { importance: 0.95 });
  return mock;
}

const sysOf = (out: unknown[]) =>
  (out.find((r) => (r as { appendSystemContext?: string })?.appendSystemContext) as { appendSystemContext?: string })?.appendSystemContext ?? "";

let n = 0;
const sessionCtx = () => {
  n += 1;
  return { agentId: AGENT, sessionKey: `agent:${AGENT}:tg:ext${n}`, sessionId: `ext-s${n}` };
};

test("baseline: no host MEMORY.md/USER.md -> goals are injected (bootstrap and every-turn header)", async () => {
  const { rec, fire } = register(workspace({}));
  const ctx = sessionCtx();

  await fire("session_start", { ...ctx }, ctx);
  expect(rec.injections[0].text).toContain("[BRAIN: active goals]");
  expect(rec.injections[0].text).toContain(BOOTSTRAP_GOALS);

  const out = await fire("before_prompt_build", { prompt: "hi", messages: [] }, ctx);
  expect(sysOf(out)).toContain(HEADER_GOALS);
});

test("host MEMORY.md has content -> bootstrap omits the goals block, BRAIN_HEADER stays", async () => {
  const { rec, fire } = register(workspace({ "MEMORY.md": "# Memory\n- Hailey prefers PowerShell.\n" }));
  const ctx = sessionCtx();

  await fire("session_start", { ...ctx }, ctx);
  expect(rec.injections[0].text).not.toContain("[BRAIN: active goals]");
  expect(rec.injections[0].text).not.toContain(BOOTSTRAP_GOALS);
  expect(rec.injections[0].text).toContain("[SharpWave active]");
});

test("host USER.md alone is enough -> every-turn header omits goals but keeps the SharpWave header", async () => {
  const { fire } = register(workspace({ "USER.md": "Name: Hailey\n" }));
  const ctx = sessionCtx();

  const out = await fire("before_prompt_build", { prompt: "hi", messages: [] }, ctx);
  expect(sysOf(out)).not.toContain("[goals]");
  expect(sysOf(out)).toContain("[SharpWave]");
});

test("heartbeat header also omits goals when the host memory tier is active (and has them otherwise)", async () => {
  const hbCtx = { agentId: AGENT, sessionKey: `agent:${AGENT}:hb` };
  const textOf = (out: unknown[]) => (out as Array<{ appendContext?: string } | undefined>).map((r) => r?.appendContext ?? "").join("\n");

  const active = register(workspace({ "MEMORY.md": "curated\n" }));
  const withHost = textOf(await active.fire("heartbeat_prompt_contribution", {}, hbCtx));
  expect(withHost).toContain("[SharpWave]");
  expect(withHost).not.toContain("[goals]");

  const plain = register(workspace({}));
  expect(textOf(await plain.fire("heartbeat_prompt_contribution", {}, hbCtx))).toContain(HEADER_GOALS);
});

test("empty/whitespace MEMORY.md does not count as an active host tier -> goals still injected", async () => {
  const { rec, fire } = register(workspace({ "MEMORY.md": "  \n\n" }));
  const ctx = sessionCtx();

  await fire("session_start", { ...ctx }, ctx);
  expect(rec.injections[0].text).toContain(BOOTSTRAP_GOALS);
});

test("older host without runtime.agent -> fails closed: goals still injected, nothing throws", async () => {
  const { rec, fire } = register(); // no workspaceDir => no api.runtime.agent
  const ctx = sessionCtx();

  await fire("session_start", { ...ctx }, ctx);
  expect(rec.injections[0].text).toContain(BOOTSTRAP_GOALS);
});
