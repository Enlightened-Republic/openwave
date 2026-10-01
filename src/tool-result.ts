// The OpenClaw tool-result shape every openwave brain_* tool returns (local and
// remote mode).
//
// OpenClaw's AgentToolResult is { content: [{ type: "text", text }], details }.
// `content` is what a model sees when it calls the tool directly. `details` is
// the structured value, and some OpenClaw paths hand ONLY `details` to the model:
//   - Code Mode (tools.codeMode; "auto" engages it for catalog-preferred models
//     such as claude-opus-5 / gpt-5.6): a guest program's `await brain_query(...)`
//     resolves to `details` (docs/tools/code-mode/guest-api.md: "Calling a native
//     global ... returns the normal tool's JSON details value directly");
//   - Tool Search / Code Mode catalog callValue (projectToolResultValue).
// openwave <= 0.1.2 returned `details: {}`, so in those paths every brain_* tool
// came back as `{}` even though `content` held the real text (live bug on
// OpenClaw 2026.9.7: brain_query returned {} for agent main).
//
// So `details` always carries the text too, plus `error` on a tool-level failure
// (OpenClaw grades a call failed from details.error) and `data` when the text is
// a JSON document (format:"json" outputs), so guest code can use it directly.

export type BrainToolDetails = {
  /** Exactly the text in content[0].text. */
  text: string;
  /** Present (same text) only when the tool failed. */
  error?: string;
  /** Parsed JSON when the tool returned a JSON object/array (e.g. brain_query format:"json"). */
  data?: unknown;
};

export type BrainToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: BrainToolDetails;
};

/**
 * Declared on every brain_* tool as `outputSchema` (describes `details`).
 * OpenClaw validates the final details against it on catalog calls and turns it
 * into the compact Code Mode / Tool Search output hint.
 */
export const BRAIN_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "The tool's full text output (same as the content block)." },
    error: { type: "string", description: "Set only when the call failed; same text." },
    // Parsed JSON, present only when the output is JSON (e.g. brain_query with
    // format:"json"). Deliberately a bare {} (no description): OpenClaw only
    // emits the compact output hint for a complete schema, and an annotated
    // "any" leaf counts as incomplete.
    data: {},
  },
  required: ["text"],
  additionalProperties: false,
} as const;

function parseJsonDoc(text: string): unknown {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Build the plain, JSON-safe AgentToolResult for a brain_* tool. */
export function brainToolResult(text: string, opts: { isError?: boolean } = {}): BrainToolResult {
  const s = typeof text === "string" ? text : String(text ?? "");
  const details: BrainToolDetails = { text: s };
  if (opts.isError) details.error = s || "brain tool failed";
  else {
    const data = parseJsonDoc(s);
    if (data !== undefined) details.data = data;
  }
  return { content: [{ type: "text", text: s }], details };
}
