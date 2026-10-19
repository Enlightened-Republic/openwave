// Local mode, owner-only identity (xanima-core identity.changesFrom, default ["owner_turn"]):
//   - with no commands.ownerAllowFrom the plugin counts a clean conversational turn as the owner's
//     (changesFrom owner_turn + agent_turn); reflection runs are held either way;
//   - with an owner list, an agent_turn proposal is held and only an attested owner turn applies;
//   - brain_review accept / reject works from the owner's conversation (admin in local mode), never
//     from a cron / heartbeat run;
//   - the workspace mirror only follows APPLIED changes (a held remove must not drop the line).
import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as core from "xanima-core";
import plugin, { identityPolicyFor, ownerIsPresent } from "../src/index.js";
import { sharedIdentityTracker } from "../src/identity-provenance.js";
import { makeMockApi } from "./mock-api.js";

type ToolCtx = { agentId?: string; sessionKey?: string; sessionId?: string };
type ToolResult = { content?: Array<{ type: string; text: string }>; details?: { error?: string } };

function setup(agents: string[], hostConfig: Record<string, unknown>, extra: Record<string, unknown> = {}, workspaceDir?: string) {
  const mock = makeMockApi({ enabled: true, config: { agents, ...extra } }, { configFile: hostConfig, ...(workspaceDir ? { workspaceDir } : {}) });
  plugin.register(mock.api as never);
  return mock;
}
function buildTool(mock: ReturnType<typeof setup>, name: string, ctx: ToolCtx) {
  for (const entry of mock.rec.tools) {
    const def = typeof entry === "function" ? entry(ctx) : entry;
    if (def?.name === name) return def as { execute: (id: string, params: unknown) => Promise<ToolResult> };
  }
  throw new Error(`tool not registered: ${name}`);
}
const textOf = (r: ToolResult) => r?.content?.[0]?.text ?? "";
const tracker = sharedIdentityTracker(() => false, []);
const reviewId = (text: string) => /(rv-i[0-9a-f]+)/.exec(text)?.[1] ?? "";

test("identityPolicyFor / ownerIsPresent: single-user box vs configured owner list", () => {
  const base = { ...core.DEFAULT_CONFIG, enabled: true, agents: ["x"] } as Parameters<typeof identityPolicyFor>[0];
  expect(identityPolicyFor(base, {}).identity?.changesFrom).toEqual(["owner_turn", "agent_turn"]);
  expect(identityPolicyFor(base, { commands: { ownerAllowFrom: ["telegram:123"] } }).identity?.changesFrom).toBeUndefined();
  const explicit = { ...base, identity: { changesFrom: ["owner_turn"] as Array<"owner_turn"> } };
  expect(identityPolicyFor(explicit, {}).identity?.changesFrom).toEqual(["owner_turn"]);
  expect(ownerIsPresent("owner_turn", { commands: { ownerAllowFrom: ["telegram:123"] } })).toBe(true);
  expect(ownerIsPresent("agent_turn", { commands: { ownerAllowFrom: ["telegram:123"] } })).toBe(false);
  expect(ownerIsPresent("agent_turn", {})).toBe(true);
  expect(ownerIsPresent("reflection", {})).toBe(false);
  expect(ownerIsPresent("tool_output", {})).toBe(false);
});

test("no owner list: a conversational turn applies, a reflection run is held, and the owner accepts it from the conversation", async () => {
  const A = "idown-solo";
  const mock = setup([A], {});
  const chat: ToolCtx = { agentId: A, sessionKey: `agent:${A}:main`, sessionId: "s-main" };
  const cron: ToolCtx = { agentId: A, sessionKey: `agent:${A}:cron:11111111-1111-1111-1111-111111111111:run:1`, sessionId: "s-cron" };
  tracker.newRun(chat.sessionKey!, "unknown");
  tracker.newRun(cron.sessionKey!, "unknown");

  const applied = textOf(await buildTool(mock, "brain_identity", chat).execute("c1", { action: "add", target: "field", field: "Vibe", value: "warm, direct", reason: "how I talk" }));
  expect(applied).toMatch(/Identity updated \(v1\)/);

  const held = textOf(await buildTool(mock, "brain_identity", cron).execute("c2", { action: "change", target: "field", field: "Vibe", value: "terse", reason: "I think I ramble" }));
  expect(held).toMatch(/^Held for your owner's review \(rv-i/);
  const id = reviewId(held);
  expect(id).toBeTruthy();
  expect(textOf(await buildTool(mock, "brain_identity", chat).execute("c3", { action: "get" }))).toContain("warm, direct");

  // a cron run cannot accept its own proposal
  const fromCron = await buildTool(mock, "brain_review", cron).execute("c4", { action: "accept", id });
  expect(fromCron.details?.error ?? textOf(fromCron)).toMatch(/only the owner can accept or reject/);
  // the owner, in conversation, can
  const acc = await buildTool(mock, "brain_review", chat).execute("c5", { action: "accept", id });
  expect(acc.details?.error).toBeUndefined();
  expect(textOf(acc)).toMatch(/^accepted rv-i/);
  expect(textOf(await buildTool(mock, "brain_identity", chat).execute("c6", { action: "get" }))).toContain("terse");
  // list / show never needed the owner
  expect(textOf(await buildTool(mock, "brain_review", cron).execute("c7", { action: "list", kind: "identity_change", status: "accepted" }))).toMatch(/review item/);
});

test("owner list configured: an agent_turn proposal is held; only an attested owner turn applies or accepts; a tool-tainted run can do neither", async () => {
  const A = "idown-owned";
  const host = { commands: { ownerAllowFrom: ["telegram:123"] } };
  const mock = setup([A], host);
  const key = `agent:${A}:main`;
  const chat: ToolCtx = { agentId: A, sessionKey: key, sessionId: "s-main" };

  tracker.newRun(key, "unknown"); // sender not classifiable → agent_turn
  const held = textOf(await buildTool(mock, "brain_identity", chat).execute("o1", { action: "add", target: "field", field: "Vibe", value: "terse", reason: "felt right" }));
  expect(held).toMatch(/^Held for your owner's review/);
  const id = reviewId(held);
  const notOwner = await buildTool(mock, "brain_review", chat).execute("o2", { action: "accept", id });
  expect(notOwner.details?.error ?? textOf(notOwner)).toMatch(/only the owner can accept or reject/);

  tracker.newRun(key, "owner"); // the owner's message started this run
  tracker.toolResult(key, "web_fetch", "some page text that taints the run");
  const tainted = await buildTool(mock, "brain_review", chat).execute("o3", { action: "accept", id });
  expect(tainted.details?.error ?? textOf(tainted)).toMatch(/tainted by tool output/);

  tracker.newRun(key, "owner");
  expect(textOf(await buildTool(mock, "brain_review", chat).execute("o4", { action: "accept", id }))).toMatch(/^accepted/);
  expect(textOf(await buildTool(mock, "brain_identity", chat).execute("o5", { action: "get" }))).toContain("terse");
  expect(textOf(await buildTool(mock, "brain_identity", chat).execute("o6", { action: "change", target: "field", field: "Vibe", value: "terse but kind", reason: "we talked about it" }))).toMatch(/Identity updated \(v2\)/);
});

test("identityMirror follows applied changes only: a held remove keeps the IDENTITY.md line", async () => {
  const A = "idown-mirror";
  const ws = mkdtempSync(join(tmpdir(), "xanima-idown-"));
  writeFileSync(join(ws, "IDENTITY.md"), "# IDENTITY\n\n- **Name:** Rid\n- **Creature:** familiar\n");
  const host = { commands: { ownerAllowFrom: ["telegram:123"] } };
  const mock = setup([A], host, { identityMirror: true }, ws);
  const key = `agent:${A}:main`;
  const chat: ToolCtx = { agentId: A, sessionKey: key, sessionId: "s-main" };
  const settle = () => new Promise((r) => setTimeout(r, 300));

  tracker.newRun(key, "owner");
  expect(textOf(await buildTool(mock, "brain_identity", chat).execute("m1", { action: "add", target: "field", field: "Vibe", value: "quiet", reason: "owner said so" }))).toMatch(/Identity updated \(v1\)/);
  await settle();
  expect(readFileSync(join(ws, "IDENTITY.md"), "utf8")).toContain("- **Vibe:** quiet");

  tracker.newRun(key, "unknown"); // agent_turn with an owner list → held
  expect(textOf(await buildTool(mock, "brain_identity", chat).execute("m2", { action: "remove", target: "field", field: "Vibe", reason: "don't need it" }))).toMatch(/^Held for your owner's review/);
  await settle();
  expect(readFileSync(join(ws, "IDENTITY.md"), "utf8")).toContain("- **Vibe:** quiet"); // nothing applied, nothing mirrored
});
