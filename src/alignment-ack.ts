/**
 * Xanima 0.2.0: the goal alignment note is OFFERED by before_prompt_build and
 * only DELIVERED (acked) when the prompt it was injected into produced a real
 * assistant reply. A turn where the agent only called memory tools
 * (brain_status, brain_list_goals, …) does not use it up; neither does a
 * skipped cron / heartbeat / noise turn or an empty reply.
 */
export interface OfferedNote { noteId: number; brainTools: number; otherTools: number; at: number }

const toolNameOf = (toolName: unknown, params: unknown): string => {
  const n = typeof toolName === "string" ? toolName : "";
  // OpenClaw's deferred tool catalog calls tools as tool_call {id, args}
  if (n === "tool_call" && params && typeof params === "object" && typeof (params as { id?: unknown }).id === "string") return (params as { id: string }).id;
  return n;
};

export class AlignmentAckTracker {
  private readonly offered = new Map<string, OfferedNote>();

  offer(agentId: string, noteId: number | null | undefined): void {
    if (typeof noteId === "number") this.offered.set(agentId, { noteId, brainTools: 0, otherTools: 0, at: Date.now() });
    else this.offered.delete(agentId);
  }

  toolCall(agentId: string, toolName: unknown, params: unknown): void {
    const p = this.offered.get(agentId);
    if (!p) return;
    if (/^brain_/.test(toolNameOf(toolName, params))) p.brainTools++;
    else p.otherTools++;
  }

  /** The reply is in. Returns the note id to ack, or null (tool-only turn / no note). Clears the offer either way. */
  replied(agentId: string, text: string): number | null {
    const p = this.offered.get(agentId);
    if (!p) return null;
    this.offered.delete(agentId);
    if (!text.trim()) return null;
    if (p.brainTools > 0 && p.otherTools === 0) return null; // memory-tool-only turn
    return p.noteId;
  }

  pending(agentId: string): OfferedNote | undefined { return this.offered.get(agentId); }
}
