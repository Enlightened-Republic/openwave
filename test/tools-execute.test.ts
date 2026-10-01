import { afterAll, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "sharpwave-core";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";
import { assertPlainJson, directText, projectToolResultValue } from "./openclaw-projection.js";
import { BRAIN_TOOL_OUTPUT_SCHEMA } from "../src/tool-result.js";
import { Value } from "typebox/value";

// Tools are called by OpenClaw as execute(toolCallId, params, signal, onUpdate, ctx)
// (docs/plugins/building-plugins.md; OpenClawPluginToolContext in the SDK types), and
// registerTool takes a per-run factory that receives { agentId, sessionKey, sessionId }.
// openwave used to declare execute(args, ctx): every parameterized brain_ tool received the
// tool-call id string as its arguments (brain_docs saw section "" on 2026-09-20), and the
// calling agent was resolved through agentIdFromKey, whose fallback is the FIRST configured
// agent (main). These tests pin the correct contract and, above all, that an unidentified
// caller is REFUSED instead of silently reading or writing another agent's brain.

const A = "toolsa";
const B = "toolsb";
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type ToolCtx = { agentId?: string; sessionKey?: string; sessionId?: string };
type ToolResult = { content?: Array<{ type: string; text: string }>; details?: { text: string; error?: string; data?: unknown } };

function setup(extra: Record<string, unknown> = {}) {
  const mock = makeMockApi({ enabled: true, config: { agents: [A, B], ...extra } });
  plugin.register(mock.api as never);
  return mock;
}

// Build the named tool exactly like the host does for one run.
function buildTool(mock: ReturnType<typeof setup>, name: string, ctx: ToolCtx) {
  for (const entry of mock.rec.tools) {
    const def = typeof entry === "function" ? entry(ctx) : entry;
    if (def?.name === name) return def as { name: string; execute: (id: string, params: unknown) => Promise<ToolResult> };
  }
  throw new Error(`tool not registered: ${name}`);
}

const textOf = (r: ToolResult) => r?.content?.[0]?.text ?? "";
const countNodes = (agent: string, label: string) =>
  (core.getDb(agent).prepare("SELECT COUNT(*) AS c FROM nodes WHERE label = ?").get(label) as { c: number }).c;

test("execute receives the params as its SECOND argument (brain_docs reads the requested section)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ow-docs-"));
  dirs.push(dir);
  writeFileSync(join(dir, "BRAIN_MEMO.md"), "# Memo\nhello from the memo file\n");
  const mock = setup({ brainDocsDir: dir });

  const tool = buildTool(mock, "brain_docs", { agentId: A });
  const out = await tool.execute("call_1", { section: "memo" });

  expect(textOf(out)).toContain("hello from the memo file");
  expect(textOf(out)).not.toContain('unknown section ""');
});

test("results use the OpenClaw content[] shape", async () => {
  const mock = setup();
  const tool = buildTool(mock, "brain_reflect", { agentId: A });
  const out = await tool.execute("call_2", {});

  expect(Array.isArray(out.content)).toBe(true);
  expect(out.content![0].type).toBe("text");
  expect(typeof out.content![0].text).toBe("string");
});

// openwave <= 0.1.2 returned details: {} and OpenClaw Code Mode hands the model
// ONLY details, so brain_query came back as {} (live on 2026.9.7, remote mode;
// local mode had the same shape). See test/remote/tool-results.test.ts.
test("local brain_query: the memory text reaches the model on the direct AND the Code Mode path", async () => {
  const mock = setup();
  await buildTool(mock, "brain_write", { agentId: A }).execute("w1", {
    type: "semantic", label: "Hailey dog", content: "Hailey has a corgi named Biscuit.",
  });

  const out = await buildTool(mock, "brain_query", { agentId: A }).execute("q1", { query: "Hailey corgi" });

  assertPlainJson(out);
  const direct = directText(out);
  expect(direct).toContain("Hailey has a corgi named Biscuit.");
  const codeMode = projectToolResultValue(out) as { text: string; error?: string };
  expect(codeMode).not.toEqual({});
  expect(codeMode.text).toBe(direct);
  expect(codeMode.error).toBeUndefined();
  expect(Value.Check(BRAIN_TOOL_OUTPUT_SCHEMA, out.details)).toBe(true);
});

test("every local tool declares the brain_* outputSchema; a refused call sets details.error", async () => {
  const mock = setup();
  for (const entry of mock.rec.tools) {
    const def = (entry as (c: ToolCtx) => { name: string; outputSchema?: unknown })({ agentId: A });
    expect(def.outputSchema, def.name).toEqual(BRAIN_TOOL_OUTPUT_SCHEMA);
  }
  const out = await buildTool(mock, "brain_write", {}).execute("c0", { type: "semantic", label: "x", content: "x" });
  const codeMode = projectToolResultValue(out) as { text: string; error?: string };
  expect(codeMode.text).toMatch(/cannot determine/i);
  expect(codeMode.error).toBe(codeMode.text);
});

test("brain_write lands in the CALLING agent's brain only", async () => {
  const mock = setup();
  const label = "routing-a-only";

  const out = await buildTool(mock, "brain_write", { agentId: A }).execute("call_3", {
    type: "semantic", label, content: "written by A",
  });

  expect(textOf(out)).not.toMatch(/invalid arguments/i);
  expect(countNodes(A, label)).toBe(1);
  expect(countNodes(B, label)).toBe(0);
});

test("two agents writing through their own tools stay in their own brains", async () => {
  const mock = setup();

  await buildTool(mock, "brain_write", { agentId: A }).execute("c1", { type: "semantic", label: "iso-a", content: "a" });
  await buildTool(mock, "brain_write", { agentId: B }).execute("c2", { type: "semantic", label: "iso-b", content: "b" });

  expect([countNodes(A, "iso-a"), countNodes(B, "iso-a")]).toEqual([1, 0]);
  expect([countNodes(A, "iso-b"), countNodes(B, "iso-b")]).toEqual([0, 1]);
});

test("agent is taken from sessionKey when the context has no agentId", async () => {
  const mock = setup();
  const label = "from-session-key";

  await buildTool(mock, "brain_write", { sessionKey: `agent:${B}:tg:123` }).execute("c4", {
    type: "semantic", label, content: "x",
  });

  expect(countNodes(B, label)).toBe(1);
  expect(countNodes(A, label)).toBe(0);
});

test("unidentifiable caller is REFUSED and writes nothing (no fallback to the first agent)", async () => {
  const mock = setup();
  const label = "must-not-exist-anywhere";

  const out = await buildTool(mock, "brain_write", {}).execute("c5", { type: "semantic", label, content: "x" });

  expect(textOf(out)).toMatch(/cannot determine/i);
  expect(countNodes(A, label)).toBe(0);
  expect(countNodes(B, label)).toBe(0);
});

test("an agent openwave does not serve is refused", async () => {
  const mock = setup();
  const label = "stranger-write";

  const out = await buildTool(mock, "brain_write", { agentId: "stranger" }).execute("c6", { type: "semantic", label, content: "x" });

  expect(textOf(out)).toMatch(/not serving/i);
  expect(countNodes(A, label)).toBe(0);
  expect(countNodes(B, label)).toBe(0);
});

test("every tool name in the manifest is registered (contracts.tools must match registerTool)", async () => {
  const mock = setup();
  const registered = mock.rec.tools.map((e: unknown) => (typeof e === "function" ? (e as (c: ToolCtx) => { name: string })({ agentId: A }) : (e as { name: string })).name).sort();
  const manifest = (await import("../openclaw.plugin.json", { with: { type: "json" } })).default as { contracts: { tools: string[] } };

  expect(registered).toEqual([...manifest.contracts.tools].sort());
});
