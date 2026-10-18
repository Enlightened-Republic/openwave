// Identity provenance + workspace mirror for brain_identity (Xanima 0.5.0 follow-up).
//
// The brain service applies an agent's own identity change at once but HOLDS one that was
// prompted by tool / web output or an untrusted sender. The model can't be trusted to say which
// it was, so the plugin — which sees the turn — attests it: every brain_identity call gets
// `attested_provenance` set here (any model-supplied value is overwritten).
//
//   agent_turn        nothing untrusted reached the model in this run
//   tool_output       a non-memory tool (web_fetch, read, exec, …) returned output in this run
//   untrusted_sender  the run started from a non-owner message (only when commands.ownerAllowFrom is set)
//   tool_output_echo  the proposed text repeats recent tool output from this session (earlier runs)
//
// A run = from an inbound message (or the first hook of a session) to agent_end.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const IDENTITY_TOOL = "brain_identity";
/** Catalog / plumbing tools whose output is not outside content. */
const BENIGN_TOOLS = new Set(["tool_search", "tool_describe", "sessions_yield"]);
const ECHO_BUFFER_CHARS = 32_000;

export type IdentityOrigin = "agent_turn" | "tool_output" | "untrusted_sender" | "tool_output_echo";
export interface Attestation { origin: IdentityOrigin; tools?: string[]; via: "openclaw" }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();

export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  try { return JSON.stringify(result) ?? ""; } catch { return ""; }
}

/** The tool that actually ran: OpenClaw's deferred catalog wraps calls as tool_call {id, args}. */
export function effectiveToolName(toolName: string | undefined, params: Record<string, unknown> | undefined): string {
  const n = toolName ?? "";
  if (n === "tool_call" && typeof params?.["id"] === "string") return params["id"];
  return n;
}

export class IdentityProvenanceTracker {
  private runTools = new Map<string, Set<string>>();
  private runSender = new Map<string, boolean>();
  private echo = new Map<string, string>();
  constructor(private readonly isMemoryTool: (name: string) => boolean, private readonly trusted: readonly string[] = []) {}

  /** after_tool_call: non-memory tool output taints the run and feeds the echo buffer. */
  toolResult(session: string, toolName: string, result: unknown): void {
    if (!session || !toolName || this.isMemoryTool(toolName) || BENIGN_TOOLS.has(toolName) || this.trusted.includes(toolName)) return;
    const s = this.runTools.get(session) ?? new Set<string>();
    s.add(toolName);
    this.runTools.set(session, s);
    const text = norm(resultText(result)).slice(0, 8000);
    if (text) this.echo.set(session, `${this.echo.get(session) ?? ""} ${text}`.slice(-ECHO_BUFFER_CHARS));
  }
  /** message_received: a new run starts; remember whether its sender is untrusted. */
  newRun(session: string, untrustedSender: boolean): void {
    if (!session) return;
    this.runTools.delete(session);
    this.runSender.set(session, untrustedSender);
  }
  endRun(session: string): void {
    if (!session) return;
    this.runTools.delete(session);
    this.runSender.delete(session);
  }
  /** Origin of an identity change proposed now in this session (proposed texts: the new value, label). */
  attest(session: string, proposedText: string | string[]): Attestation {
    const tools = [...(this.runTools.get(session) ?? [])];
    if (tools.length) return { origin: "tool_output", tools, via: "openclaw" };
    if (this.runSender.get(session)) return { origin: "untrusted_sender", via: "openclaw" };
    if ((Array.isArray(proposedText) ? proposedText : [proposedText]).some((t) => this.echoes(session, t))) return { origin: "tool_output_echo", via: "openclaw" };
    return { origin: "agent_turn", via: "openclaw" };
  }
  private echoes(session: string, text: string): boolean {
    const buf = this.echo.get(session);
    const t = norm(text);
    if (!buf || t.length < 16) return false;
    if (buf.includes(t)) return true;
    const w = t.split(" ");
    for (let i = 0; i + 6 <= w.length; i++) if (buf.includes(w.slice(i, i + 6).join(" "))) return true;
    return false;
  }
  clear(): void { this.runTools.clear(); this.runSender.clear(); this.echo.clear(); }
}

/** Stamp a brain_identity call: drop whatever the model put in attested_provenance and set the plugin's. */
/** The field an applied brain_identity call removed (so the mirror drops that line), else none. */
export function removedFieldOf(args: Record<string, unknown>): string[] {
  return args["action"] === "remove" && (args["target"] ?? "field") === "field" && typeof args["field"] === "string" ? [args["field"]] : [];
}

export function attestIdentityArgs(params: Record<string, unknown>, tracker: IdentityProvenanceTracker, session: string): Record<string, unknown> {
  const { attested_provenance: _ignored, ...rest } = params;
  const action = String(rest["action"] ?? "");
  if (!["add", "change", "remove"].includes(action)) return rest;
  const text = [rest["value"], rest["label"]].filter((x): x is string => typeof x === "string");
  return { ...rest, attested_provenance: tracker.attest(session, text) };
}

// ─── workspace mirror (identityMirror: true; default off) ─────────────────────

const FIELD_RE = /^- \*\*([^*\n]+?):\*\*[ \t]?(.*)$/;
const VALUES_START = "<!-- xanima:values:start (managed by Xanima: values the agent added or changed; edit them with brain_identity) -->";
const VALUES_END = "<!-- xanima:values:end -->";

/**
 * IDENTITY.md: only `- **Field:** value` lines change: values updated, new fields after the last field, and a
 * field dropped only when the agent just removed it (`removed`). Lines the brain doesn't know are left alone.
 */
export function mirrorIdentityText(file: string, fields: Array<{ key: string; value: string }>, removed: readonly string[] = []): string {
  const lines = file.split("\n");
  const want = new Map(fields.map((f) => [f.key.toLowerCase(), f]));
  const seen = new Set<string>();
  const out: string[] = [];
  let lastField = -1;
  for (const line of lines) {
    const m = FIELD_RE.exec(line);
    if (!m) { out.push(line); continue; }
    const k = m[1]!.trim().toLowerCase();
    const f = want.get(k);
    if (!f) {
      if (removed.some((r) => r.trim().toLowerCase() === k)) continue;
      out.push(line); lastField = out.length - 1; continue;
    }
    seen.add(k);
    out.push(`- **${m[1]!.trim()}:** ${f.value}`);
    lastField = out.length - 1;
  }
  const add = fields.filter((f) => !seen.has(f.key.toLowerCase())).map((f) => `- **${f.key}:** ${f.value}`);
  if (add.length) out.splice(lastField >= 0 ? lastField + 1 : out.length, 0, ...add);
  return out.join("\n");
}

/** SOUL.md: a managed block listing the values the agent itself added or changed (source self_observation). */
export function mirrorSoulText(file: string, values: Array<{ label: string; content: string; source_type?: string | null }>): string {
  const own = values.filter((v) => v.source_type === "self_observation");
  const block = own.length ? [VALUES_START, "## Evolved values", "", ...own.map((v) => `**${v.label.replace(/\*/g, "")}** ${v.content.replace(/\s+/g, " ").trim()}\n`), VALUES_END].join("\n") : "";
  const a = file.indexOf(VALUES_START), b = file.indexOf(VALUES_END);
  if (a >= 0 && b > a) return `${file.slice(0, a)}${block}${file.slice(b + VALUES_END.length)}`.replace(/\n{3,}$/, "\n\n");
  if (!block) return file;
  return `${file.replace(/\s*$/, "")}\n\n${block}\n`;
}

/** Write the brain's identity back into the workspace files. Returns the files changed. */
export function mirrorIdentityToWorkspace(dir: string, state: { fields: Array<{ key: string; value: string }>; values: Array<{ label: string; content: string; source_type?: string | null }> }, removed: readonly string[] = []): string[] {
  const changed: string[] = [];
  const idf = join(dir, "IDENTITY.md");
  if (existsSync(idf)) {
    const before = readFileSync(idf, "utf8");
    const after = mirrorIdentityText(before, state.fields, removed);
    if (after !== before) { writeFileSync(idf, after); changed.push("IDENTITY.md"); }
  }
  const sf = join(dir, "SOUL.md");
  if (existsSync(sf)) {
    const before = readFileSync(sf, "utf8");
    const after = mirrorSoulText(before, state.values);
    if (after !== before) { writeFileSync(sf, after); changed.push("SOUL.md"); }
  }
  return changed;
}
