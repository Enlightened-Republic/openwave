/**
 * Xanima 0.2.0: the goal alignment note is OFFERED by before_prompt_build and
 * only DELIVERED (acked) when the prompt it was injected into produced a real
 * assistant reply. A turn where the agent only called memory tools
 * (brain_status, brain_list_goals, …) does not use it up; neither does a
 * skipped cron / heartbeat / noise turn or an empty reply.
 */
export interface OfferedNote { noteId: number; /** Xanima 0.3.0: every offered note this turn (alignment note + commitment nudge). */ noteIds: number[]; brainTools: number; otherTools: number; at: number }

const toolNameOf = (toolName: unknown, params: unknown): string => {
  const n = typeof toolName === "string" ? toolName : "";
  // OpenClaw's deferred tool catalog calls tools as tool_call {id, args}
  if (n === "tool_call" && params && typeof params === "object" && typeof (params as { id?: unknown }).id === "string") return (params as { id: string }).id;
  return n;
};

export class AlignmentAckTracker {
  private readonly offered = new Map<string, OfferedNote>();

  offer(agentId: string, noteId: number | number[] | null | undefined): void {
    const ids = (Array.isArray(noteId) ? noteId : [noteId]).filter((x): x is number => typeof x === "number");
    if (ids.length) this.offered.set(agentId, { noteId: ids[0]!, noteIds: ids, brainTools: 0, otherTools: 0, at: Date.now() });
    else this.offered.delete(agentId);
  }

  toolCall(agentId: string, toolName: unknown, params: unknown): void {
    const p = this.offered.get(agentId);
    if (!p) return;
    if (/^brain_/.test(toolNameOf(toolName, params))) p.brainTools++;
    else p.otherTools++;
  }

  /** The reply is in. Returns the first note id to ack, or null (tool-only turn / no note). Clears the offer either way. */
  replied(agentId: string, text: string): number | null {
    return this.repliedAll(agentId, text)[0] ?? null;
  }

  /** Like replied, but every offered note id (alignment note + commitment nudge). */
  repliedAll(agentId: string, text: string): number[] {
    const p = this.offered.get(agentId);
    if (!p) return [];
    this.offered.delete(agentId);
    if (!text.trim()) return [];
    if (p.brainTools > 0 && p.otherTools === 0) return []; // memory-tool-only turn
    return p.noteIds;
  }

  pending(agentId: string): OfferedNote | undefined { return this.offered.get(agentId); }
}
