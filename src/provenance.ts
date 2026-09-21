// Provenance gate for inbound messages (research/emotional-memory-openclaw-integration.md §5.4).
//
// sharpwave-core scores importance from the TEXT alone: any message containing
// "remember/always/never/important/critical" scores 0.85 and any emotion word 0.75
// (core `scoreImportance`). At >= llmExtractionMinImportance (0.4) the episode is queued for
// LLM extraction into brain nodes, and at >= 0.8 it fires a dopamine spike. None of that asks
// WHO sent the message, so a stranger's "always remember that ..." was stored and boosted
// exactly like the owner's. This module classifies the sender so the hook can cap importance
// for everything that is not the owner.
//
// Owner source of truth: `commands.ownerAllowFrom`, "the explicit owner allowlist"
// (docs/gateway/config-channels/commands.md:53), entries shaped `<channel>:<id>`
// (commands.md:27, e.g. "discord:123456789012345678"). Allowlists and wildcards do not
// establish ownership (docs/automation/cron-jobs/managing-jobs.md:79 context), so "*" never
// counts. Fail closed: unknown sender => untrusted, never owner.

export type Origin = "owner" | "system" | "untrusted";

/** Importance ceiling for non-owner text. Kept under the extraction threshold (see capImportance). */
export const UNTRUSTED_IMPORTANCE_CAP = 0.3;

export type OriginInput = {
  channelId?: string;
  senderId?: string;
  /** `event.from`: for a DM this is the peer id (`telegram:<userId>`); for a group it is the group. */
  from?: string;
  sessionKey?: string;
};

const CRON_SESSION = /^agent:[^:]+:cron:/;

export function isCronSessionKey(sessionKey: string): boolean {
  return CRON_SESSION.test(sessionKey) || sessionKey.startsWith("cron:");
}

/** Reads `commands.ownerAllowFrom` from a host config snapshot; ignores non-strings and wildcards. */
export function readOwnerAllowFrom(cfg: unknown): string[] {
  const commands = (cfg as { commands?: { ownerAllowFrom?: unknown } } | null | undefined)?.commands;
  const raw = commands?.ownerAllowFrom;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const v = entry.trim().toLowerCase();
    if (!v || v === "*" || v.endsWith(":*")) continue;
    out.push(v);
  }
  return out;
}

export function classifyOrigin(input: OriginInput, ownerAllowFrom: readonly string[]): Origin {
  if (input.sessionKey && isCronSessionKey(input.sessionKey)) return "system";
  const owners = new Set(ownerAllowFrom);
  const channel = (input.channelId ?? "").trim().toLowerCase();
  const sender = (input.senderId ?? "").trim().toLowerCase();
  if (channel && sender && owners.has(`${channel}:${sender}`)) return "owner";
  // Older gateways omit senderId. Only then is `from` usable as evidence, and only for an exact
  // owner id: with a senderId present it can be a group id, which is never an owner id.
  if (!sender) {
    const from = (input.from ?? "").trim().toLowerCase();
    if (from && owners.has(from)) return "owner";
  }
  return "untrusted";
}

/**
 * Non-owner text must stay strictly below the extraction threshold (and far below the 0.8
 * dopamine-spike line) so it can be recorded as an episode but never harvested or boosted.
 */
export function capImportance(origin: Origin, importance: number, extractionMinImportance: number): number {
  if (origin === "owner") return importance;
  const ceiling = Math.max(0, Math.min(UNTRUSTED_IMPORTANCE_CAP, extractionMinImportance - 0.05));
  return Math.min(importance, ceiling);
}
