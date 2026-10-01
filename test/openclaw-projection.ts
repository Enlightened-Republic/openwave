// How OpenClaw turns a plugin tool's AgentToolResult into what the MODEL sees.
//
// Direct tool exposure: the model reads `content` text blocks.
// Code Mode / Tool Search catalog value calls (`await brain_query(...)` inside a
// Code Mode cell): the model reads ONLY `details`. This is a verbatim port of
// projectToolResultValue from openclaw 2026.9.7 (src/agents/tool-search.ts,
// bundled in dist/tool-search-*.mjs; used by ToolSearchRuntime.callValue /
// callExactValue). docs/tools/code-mode/guest-api.md: "Calling a native global
// or native catalog handle returns the normal tool's JSON details value directly."
//
// Kept as a copy (not imported) because the function is internal to OpenClaw's
// hashed dist chunks. The live bug: openwave returned details: {}, so this
// projection yielded {} for every brain_* tool.

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function collectTextContentBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => isRecord(b) && b["type"] === "text" && typeof b["text"] === "string").map((b) => (b as { text: string }).text);
}

function hasErrorMessage(details: unknown): boolean {
  return isRecord(details) && [details["message"], details["error"]].some((v) => typeof v === "string" && v.trim() !== "");
}

/** openclaw 2026.9.7 projectToolResultValue (Code Mode guest value). */
export function projectToolResultValue(result: unknown): unknown {
  if (!isRecord(result) || !("details" in result)) return result;
  const { details } = result;
  if (result["isError"] !== true || hasErrorMessage(details)) return details;
  const message = collectTextContentBlocks(result["content"]).map((t) => t.trim()).filter(Boolean).join("\n");
  if (!message) return details;
  if (details === undefined || details === null) return { message };
  return isRecord(details) ? { ...details, message } : details;
}

/** What a model sees under direct tool exposure. */
export function directText(result: unknown): string {
  return isRecord(result) ? collectTextContentBlocks(result["content"]).join("\n") : "";
}

/**
 * The AgentToolResult must survive OpenClaw's JSON-safe transcript snapshot
 * (snapshotToolSearchTargetTranscriptResult) unchanged: a plain object, no
 * Promise, no class instance, no undefined-only fields.
 */
export function assertPlainJson(value: unknown): void {
  if (value instanceof Promise || (isRecord(value) && typeof (value as { then?: unknown }).then === "function")) throw new Error("tool result is a thenable");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`tool result is not a plain object (prototype ${proto?.constructor?.name})`);
  const round = JSON.parse(JSON.stringify(value));
  if (JSON.stringify(round) !== JSON.stringify(value)) throw new Error("tool result is not JSON-stable");
}
