// The exact result shape openwave hands back to OpenClaw for the proxied
// brain_* tools in remote mode, against a REAL sharpwave-server.
//
// Live bug (OpenClaw 2026.9.7, openwave 0.1.2 remote): agent main's brain_query
// returned `{}`. The service was fine; openwave returned
// { content: [{ type: "text", text }], details: {} } and OpenClaw's Code Mode /
// catalog value path hands the model ONLY `details` (see ../openclaw-projection.ts).
// These tests assert what the model actually receives on BOTH paths, for every
// proxied tool, and that openwave's published input schemas match the service's.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Value } from "typebox/value";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import plugin, { __remoteRuntimeForTests } from "../../src/index.js";
import { EPISODE_APPEND_TOOL, RECALL_BLOCK_HEADER, REMOTE_TOOL_NAMES } from "../../src/remote/register.js";
import { BRAIN_TOOL_OUTPUT_SCHEMA } from "../../src/tool-result.js";
import { makeMockApi } from "../mock-api.js";
import { assertPlainJson, directText, projectToolResultValue } from "../openclaw-projection.js";
import { HAVE_SERVER, startServer, type RunningServer } from "./server-harness.js";

type Details = { text: string; error?: string; data?: unknown };
type Result = { content: Array<{ type: string; text: string }>; details: Details };
type Tool = { name: string; parameters: { type: string; properties: Record<string, Record<string, unknown>>; required?: string[] }; outputSchema?: unknown; execute: (id: string, params: unknown) => Promise<Result> };

const AGENT = "main";
const HAILEY = [
  { label: "Hailey birthday", content: "Hailey's birthday is March 3rd." },
  { label: "Hailey coffee", content: "Hailey drinks oat-milk flat whites every morning." },
  { label: "Hailey dog", content: "Hailey has a corgi named Biscuit." },
];

/** Service tools that are deliberately NOT exposed to the model. */
const INTERNAL_SERVICE_TOOLS = new Set([EPISODE_APPEND_TOOL, "brain_seed"]);

describe.skipIf(!HAVE_SERVER)("remote tool results returned to OpenClaw (real sharpwave-server)", () => {
  let svc: RunningServer;
  let token: string;
  let tools: Map<string, Tool>;
  let mock: ReturnType<typeof makeMockApi>;
  const ids: string[] = [];

  beforeAll(async () => {
    svc = await startServer();
    token = svc.mint(AGENT, ["read", "write"]);
    svc.writeTokenFile(AGENT, token);
    mock = makeMockApi({ enabled: true, config: { agents: [AGENT], brainMode: "remote", brainUrl: svc.url, brainTokenFile: join(svc.tokenDir, "{agentId}.token") } });
    plugin.register(mock.api as never);
    // Build the tools exactly like OpenClaw does for one run: factory(toolContext).
    const ctx = { agentId: AGENT, sessionKey: `agent:${AGENT}:main`, sessionId: "s-main" };
    tools = new Map(mock.rec.tools.map((f: (c: unknown) => Tool) => f(ctx)).map((t: Tool) => [t.name, t]));
    for (const m of HAILEY) {
      const r = await tools.get("brain_write")!.execute("w", { type: "semantic", ...m });
      const id = /node ([0-9a-f-]{36})/.exec(r.content[0]!.text)?.[1];
      if (!id) throw new Error(`write failed: ${r.content[0]!.text}`);
      ids.push(id);
    }
  }, 30_000);

  afterAll(async () => {
    await __remoteRuntimeForTests()?.stop();
    await svc?.stop();
  });

  const run = async (name: string, params: Record<string, unknown>) => {
    const r = await tools.get(name)!.execute(`call-${name}`, params);
    return { r, direct: directText(r), codeMode: projectToolResultValue(r) as Details };
  };

  /** Shape every proxied tool must satisfy, whatever its text. */
  const expectShape = (r: Result, codeMode: Details) => {
    assertPlainJson(r);
    expect(Object.keys(r).sort()).toEqual(["content", "details"]);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]!.type).toBe("text");
    expect(r.content[0]!.text.length).toBeGreaterThan(0);
    // The value a Code Mode program receives is never {} and carries the same text.
    expect(codeMode).not.toEqual({});
    expect(codeMode.text).toBe(r.content[0]!.text);
    expect(Value.Check(BRAIN_TOOL_OUTPUT_SCHEMA, r.details)).toBe(true);
  };

  test("brain_query: the model gets the memory text on the direct AND the Code Mode path", async () => {
    const { r, direct, codeMode } = await run("brain_query", { query: "Hailey" });
    expectShape(r, codeMode);
    expect(r).toEqual({ content: [{ type: "text", text: direct }], details: { text: direct } });
    for (const m of HAILEY) {
      expect(direct).toContain(m.content);
      expect(codeMode.text).toContain(m.content);
    }
    expect(codeMode.error).toBeUndefined();
  });

  test("brain_query format:json: details.data is the parsed result set", async () => {
    const { r, codeMode } = await run("brain_query", { query: "corgi Biscuit", format: "json", limit: 3 });
    expectShape(r, codeMode);
    const data = codeMode.data as { results: Array<{ content: string; writer: string; brain: string }> };
    expect(data.results.some((h) => h.content === "Hailey has a corgi named Biscuit." && h.writer === AGENT && h.brain === "private")).toBe(true);
    expect(JSON.parse(codeMode.text)).toEqual(data);
  });

  test("brain_write: success text reaches the model on both paths", async () => {
    const { r, codeMode } = await run("brain_write", { type: "semantic", label: "Hailey plant", content: "Hailey keeps a fiddle-leaf fig named Gerald." });
    expectShape(r, codeMode);
    expect(codeMode.text).toMatch(/^Written: node [0-9a-f-]{36} \(semantic\) "Hailey plant" brain=private writer=main/);
    expect(codeMode.error).toBeUndefined();
  });

  test("tool-level errors: text reaches the model and details.error marks the call failed", async () => {
    const { r, codeMode } = await run("brain_reset", { confirm: AGENT });
    expectShape(r, codeMode);
    expect(codeMode.text).toContain("brain_reset is disabled");
    expect(codeMode.error).toBe(codeMode.text);
    const bad = await run("brain_query", {});
    expectShape(bad.r, bad.codeMode);
    expect(bad.codeMode.error).toContain("query");
  });

  test("all 11 proxied tools return content text + details.text (none project to {})", async () => {
    const [a, b, c] = ids as [string, string, string];
    const calls: Array<[string, Record<string, unknown>, RegExp]> = [
      ["brain_query", { query: "Hailey" }, /Hailey has a corgi named Biscuit/],
      ["brain_write", { type: "semantic", label: "Hailey tea", content: "Hailey prefers jasmine tea in the evening." }, /^Written: node /],
      ["brain_link", { from_id: a, to_id: b, edge_type: "associates" }, /./],
      ["brain_stats", {}, /nodes=\d+/],
      ["brain_history", { query: "Hailey" }, /./],
      ["brain_expand", { node_id: c }, /Biscuit/],
      ["brain_review", { node_id: a, quality: 3 }, /./],
      ["brain_edges", { node_id: a }, /./],
      ["brain_supersede", { old_node_id: b, new_content: "Hailey switched to cortados." }, /./],
      ["brain_forget", { node_id: c, force: true }, /./],
      ["brain_reset", { confirm: AGENT }, /disabled/],
    ];
    expect(calls.map(([n]) => n).sort()).toEqual([...REMOTE_TOOL_NAMES].sort());
    for (const [name, params, expected] of calls) {
      const { r, codeMode } = await run(name, params);
      expectShape(r, codeMode);
      expect(codeMode.text, name).toMatch(expected);
      if (name !== "brain_reset") expect(codeMode.error, `${name}: ${codeMode.text}`).toBeUndefined();
    }
  });

  test("every proxied tool declares the outputSchema that its details satisfy", () => {
    for (const name of REMOTE_TOOL_NAMES) expect(tools.get(name)!.outputSchema, name).toEqual(BRAIN_TOOL_OUTPUT_SCHEMA);
  });

  test("input schemas match the service's advertised tool list (names, required, types, enums)", async () => {
    const client = new Client({ name: "openwave-schema-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${svc.url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      const { tools: advertised } = await client.listTools();
      const advertisedNames = new Set(advertised.map((t) => t.name));
      // Everything openwave proxies is served...
      for (const name of REMOTE_TOOL_NAMES) expect(advertisedNames.has(name), `service does not advertise ${name}`).toBe(true);
      // ...and everything served is either proxied or deliberately internal.
      for (const t of advertised) {
        if (INTERNAL_SERVICE_TOOLS.has(t.name)) { expect(tools.has(t.name)).toBe(false); continue; }
        const mine = tools.get(t.name);
        expect(mine, `service tool ${t.name} is not proxied`).toBeDefined();
        const svcSchema = t.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
        const svcProps = svcSchema.properties ?? {};
        expect(Object.keys(mine!.parameters.properties).sort(), `${t.name} param names`).toEqual(Object.keys(svcProps).sort());
        expect([...(mine!.parameters.required ?? [])].sort(), `${t.name} required`).toEqual([...(svcSchema.required ?? [])].sort());
        for (const [k, v] of Object.entries(svcProps)) {
          const m = mine!.parameters.properties[k]!;
          expect(m["type"], `${t.name}.${k} type`).toEqual(v["type"]);
          expect(m["enum"], `${t.name}.${k} enum`).toEqual(v["enum"]);
        }
      }
    } finally {
      await client.close();
    }
  });

  test("before_prompt_build recall injects the real Hailey memories in remote mode", async () => {
    const [res] = await mock.fire("before_prompt_build", { prompt: "What do you remember about Hailey?" }, { agentId: AGENT, sessionKey: `agent:${AGENT}:main`, sessionId: "s-main" });
    const block = (res as { prependContext?: string } | undefined)?.prependContext ?? "";
    expect(block.startsWith(RECALL_BLOCK_HEADER)).toBe(true);
    expect(block).toContain("Hailey birthday: Hailey's birthday is March 3rd.");
    expect(block).toContain("Hailey coffee: Hailey drinks oat-milk flat whites every morning.");
  });
});
