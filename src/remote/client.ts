// Remote brain mode: a small, failure-tolerant client for the SharpWave brain
// service (sharpwave-server). Speaks MCP Streamable HTTP through the official
// @modelcontextprotocol/sdk client transport, one connection per served agent
// (each agent has its own bearer token; the service derives identity, brain
// routing and writer_agent_id from that token).
//
// Failure model (never throw into a turn uncaught, never block past the budget):
//   - every call is bounded by `timeoutMs` (SDK request timeout + a hard
//     deadline race, so a black-holed TCP connect cannot outlive the budget);
//   - errors are classified: "unauthorized" (401/403 — bad/revoked token),
//     "unreachable" (connection refused / DNS / timeout / 5xx), "protocol";
//   - after an "unreachable" failure the client backs off (2s doubling to 60s)
//     and fails FAST during the window so a dead service costs a turn ~0ms;
//   - the token never appears in an error message or log line.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { redact } from "./settings.js";

export type RemoteErrorKind = "unauthorized" | "unreachable" | "protocol";

export class RemoteBrainError extends Error {
  constructor(public readonly kind: RemoteErrorKind, message: string, public readonly status?: number) {
    super(message);
    this.name = "RemoteBrainError";
  }
}

export type ToolCallResult = { text: string; isError: boolean };

export type RemoteClientOptions = {
  url: string;
  token: string;
  timeoutMs: number;
  /** For logs only (the service decides the real identity from the token). */
  agentId: string;
  clientVersion?: string;
  /** Test seam. */
  now?: () => number;
};

const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RemoteBrainError("unreachable", `${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export function classifyError(err: unknown, token?: string): RemoteBrainError {
  if (err instanceof RemoteBrainError) return err;
  const msg = redact(String((err as Error)?.message ?? err), token);
  if (err instanceof StreamableHTTPError) {
    const code = err.code ?? 0;
    if (code === 401 || code === 403) {
      return new RemoteBrainError("unauthorized", `brain service rejected the bearer token (HTTP ${code})`, code);
    }
    if (code >= 500 || code === 404 || code === 405 || code === -1) return new RemoteBrainError("unreachable", `brain service HTTP ${code}: ${msg.slice(0, 200)}`, code);
    return new RemoteBrainError("protocol", `brain service HTTP ${code}: ${msg.slice(0, 200)}`, code);
  }
  const name = (err as Error)?.name ?? "";
  const code = (err as { code?: unknown })?.code;
  // McpError RequestTimeout (-32001) and fetch/network failures.
  if (code === -32001 || /timed? ?out/i.test(msg)) return new RemoteBrainError("unreachable", `brain service timed out: ${msg.slice(0, 200)}`);
  if (name === "TypeError" || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|socket|network/i.test(msg)) {
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    return new RemoteBrainError("unreachable", `brain service unreachable${cause ? ` (${cause})` : ""}: ${msg.slice(0, 200)}`);
  }
  return new RemoteBrainError("protocol", msg.slice(0, 300));
}

export class RemoteBrainClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private failures = 0;
  private downUntil = 0;
  private readonly now: () => number;
  /** Last classified failure (for status reporting); cleared on success. */
  lastError: RemoteBrainError | null = null;

  constructor(private readonly opts: RemoteClientOptions) {
    this.now = opts.now ?? Date.now;
  }

  get agentId(): string { return this.opts.agentId; }

  /** True while in the post-failure backoff window (calls fail fast). */
  inBackoff(): boolean { return this.now() < this.downUntil; }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${this.opts.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${this.opts.token}` } },
      });
      const client = new Client({ name: "openwave", version: this.opts.clientVersion ?? "0" }, { capabilities: {} });
      client.onerror = () => { /* surfaced through the awaited call instead */ };
      try {
        await deadline(client.connect(transport, { timeout: this.opts.timeoutMs }), this.opts.timeoutMs, "connect");
      } catch (err) {
        void client.close().catch(() => {});
        throw err;
      }
      this.client = client;
      return client;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async reset(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => {});
  }

  private noteFailure(e: RemoteBrainError): void {
    this.lastError = e;
    if (e.kind === "unreachable") {
      this.failures++;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(this.failures - 1, 10));
      this.downUntil = this.now() + wait;
    }
  }

  private noteSuccess(): void {
    this.failures = 0;
    this.downUntil = 0;
    this.lastError = null;
  }

  /** Forget the backoff window (e.g. after a successful /health probe). */
  clearBackoff(): void { this.downUntil = 0; }

  /**
   * Call one brain tool. Resolves with the tool's text (isError=true for a
   * tool-level error such as "forbidden"); REJECTS with RemoteBrainError for
   * transport/auth failures. Bounded by timeoutMs end to end.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    if (this.inBackoff()) {
      throw new RemoteBrainError("unreachable", `brain service marked down; retrying after backoff (${Math.ceil((this.downUntil - this.now()) / 1000)}s)`);
    }
    const started = this.now();
    try {
      const run = async () => {
        const client = await this.connect();
        const remaining = Math.max(50, this.opts.timeoutMs - (this.now() - started));
        return client.callTool({ name, arguments: args }, undefined, { timeout: remaining });
      };
      const res = await deadline(run(), this.opts.timeoutMs, `brain ${name}`);
      const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      this.noteSuccess();
      return { text, isError: !!(res as { isError?: boolean }).isError };
    } catch (err) {
      const e = classifyError(err, this.opts.token);
      // Drop the connection on any transport failure so the next call re-initializes.
      await this.reset();
      this.noteFailure(e);
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }
}

export type HealthResult = { ok: true; version?: string } | { ok: false; error: string };

/** GET <url>/health (unauthenticated). Bounded by timeoutMs. */
export async function checkHealth(url: string, timeoutMs: number): Promise<HealthResult> {
  try {
    const res = await deadline(fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) }), timeoutMs + 50, "health");
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { status?: string; version?: string };
    if (body.status !== "ok") return { ok: false, error: `unexpected health body` };
    return { ok: true, ...(body.version ? { version: body.version } : {}) };
  } catch (err) {
    return { ok: false, error: classifyError(err).message };
  }
}
