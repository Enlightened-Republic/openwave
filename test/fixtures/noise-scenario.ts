// One realistic hook sequence mixing conversation with OpenClaw system turns.
// Used by the local-mode and remote-mode system-noise tests.
import { HEARTBEAT_PROMPT_9_7 } from "./system-noise-fixtures.js";

type Fire = (name: string, event: unknown, ctx: unknown) => Promise<unknown>;

export const KEPT_CONTENTS = [
  "Remember the cassowary feeding schedule is at 7am",
  "Noted: cassowary feeding at 7am.",
  "Your heartbeats are fine — can you check why the heartbeat poll fired twice last night?",
  "The heartbeat runs every 30m; when nothing needs attention it replies NO_REPLY, which OpenClaw hides.",
];

/** Substrings that must never reach an episode / queue / node. */
export const NOISE_NEEDLES = [
  "[OpenClaw heartbeat poll]", "[OpenClaw exec completion]", "Two monitors flagged", "NO_REPLY —", "owner-blocked",
  "Checked the inbox and the deploy queue", "HEARTBEAT_OK", "Saved today's notes", "build finished cleanly", "monitor scratch",
];

export async function runNoiseScenario(fire: Fire, agent: string): Promise<void> {
  const chat = { agentId: agent, sessionKey: `agent:${agent}:telegram:direct:42`, sessionId: "sess-chat" };
  const main = { agentId: agent, sessionKey: `agent:${agent}:main`, sessionId: "sess-main" };
  const hbIso = { agentId: agent, sessionKey: `agent:${agent}:main:heartbeat`, sessionId: "sess-hb" };

  await fire("message_received", { content: KEPT_CONTENTS[0] }, chat);
  await fire("llm_output", { assistantTexts: ["[[reply_to_current]] Noted: cassowary feeding at 7am."] }, chat);

  // Heartbeat poll on an older host: transcript marker arrives as a user turn; the reply has no flag (paired).
  await fire("message_received", { content: "[OpenClaw heartbeat poll]" }, main);
  await fire("llm_output", { assistantTexts: ["Two monitors flagged; nothing actionable for now, will check again at the next tick."] }, main);

  // 2026.9.7 heartbeat runs: structured trigger on the agent hook ctx.
  await fire("llm_output", { assistantTexts: ["NO_REPLY — 3:12 PM, daytime but no owner-blocked work, nothing urgent in scope, she was active 40m ago. Next scheduled tick ~15:42."] }, { ...main, trigger: "heartbeat" });
  await fire("llm_output", { assistantTexts: ["Checked the inbox and the deploy queue; nothing new since this morning."], prompt: HEARTBEAT_PROMPT_9_7 }, { ...main, trigger: "heartbeat" });

  // Exec completion wake (text marker) + provenance-flagged reply.
  await fire("message_received", { content: "[OpenClaw exec completion]\nDisable automatic completion turns with tools.exec.notifyOnExit=false; check per-agent overrides. Background exec and process poll remain available." }, main);
  await fire("llm_output", { assistantTexts: ["The build finished cleanly."] }, { ...main, inputProvenance: { kind: "internal_system", sourceTool: "exec" } });

  // Unflagged silent replies (text fallback) and a memory-flush run.
  await fire("llm_output", { assistantTexts: ["HEARTBEAT_OK"] }, main);
  await fire("llm_output", { assistantTexts: ["NO_REPLY"] }, main);
  await fire("llm_output", { assistantTexts: ["Saved today's notes to memory/2026-10-01.md."] }, { ...main, trigger: "memory" });

  // Isolated heartbeat session lifecycle + a heartbeat prompt delivered as a user turn.
  await fire("session_start", { sessionId: hbIso.sessionId, sessionKey: hbIso.sessionKey }, hbIso);
  await fire("message_received", { content: `${HEARTBEAT_PROMPT_9_7}\nCurrent time: Thursday, October 1st, 2026 — 3:12 PM (America/Denver)` }, hbIso);
  await fire("session_end", { sessionId: hbIso.sessionId, sessionKey: hbIso.sessionKey }, hbIso);

  // Normal conversation that merely talks ABOUT heartbeats: kept.
  await fire("message_received", { content: KEPT_CONTENTS[2] }, chat);
  await fire("llm_output", { assistantTexts: [KEPT_CONTENTS[3]] }, { ...chat, trigger: "user" });
}
