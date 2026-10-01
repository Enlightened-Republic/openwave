// Remote brain mode — the OpenClaw wiring used when brainMode === "remote".
//
// index.ts calls registerRemoteMode() INSTEAD of the local wiring, so in remote
// mode none of the local code paths run and no local brain.db is ever opened:
// nothing here calls core.getDb / any sharpwave-core function that touches
// SQLite. The sharpwave-core functions used are pure (tool definitions,
// importance scoring, the in-memory extraction queue + its LLM/heuristic
// extractor). The brain service owns storage AND sleep.
//
// What maps (see REMOTE_DISABLED_FEATURES for what does not):
//   - brain_* tools → proxied 1:1 to the service (11 tools it serves).
//   - before_prompt_build recall → brain_query on the service (private +
//     shared when sharedRecall), same "[BRAIN: on your mind …]" block format,
//     Graft A dedupe (identity/goal hits dropped when MEMORY.md/USER.md owns them).
//   - LLM extraction → episodes queued in memory as before; facts drained on
//     session_end and hourly and written to the service with brain_write.
//   - memory corpus supplement → brain_query.

import * as core from "sharpwave-core";
import { BRAIN_TOOL_DEFS } from "sharpwave-core";
import { capImportance, classifyOrigin, readOwnerAllowFrom } from "../provenance.js";
import { CONSOLIDATION_CRON_ID, type CronService } from "../engram-graft.js";
import { RemoteBrainClient, RemoteBrainError, checkHealth } from "./client.js";
import { BRAIN_TOOL_OUTPUT_SCHEMA, brainToolResult } from "../tool-result.js";
import {
  loadToken,
  redact,
  resolveRemoteSettings,
  tokenIsSingleAgent,
  type RemoteConfigFields,
  type ResolvedRemoteSettings,
  type TokenSource,
} from "./settings.js";
import type { BrainConnectionInfo } from "../settings-contract.js";

/** Local-only features that are switched off in remote mode (listed in the PR / README). */
export const REMOTE_DISABLED_FEATURES: readonly string[] = [
  "local brain.db (never opened)",
  "in-process sleep timers: awake replay (30m), hourly harvest-to-local, embedding sweep (10m) — the service owns sleep",
  "openwave:consolidation host cron (not registered; an existing one is removed)",
  "episode log writes ONLY when the service does not advertise brain_episode_append (older sharpwave-server); with it, episodes are appended remotely",
  "session bootstrap (self-model prose, goals, morning brief, know, recent episodes, review queue, dream context)",
  "self-model header identity/goals/neuromodulator lines (a one-line remote banner is injected instead)",
  "always-on procedural rules block",
  "last-24h cross-session activity block",
  "proactive monitor pre-priming, working-memory clears, coactivation recording, dopamine spikes",
  "VALOR injection scoring",
  "subconscious tick (agent_end) and compaction graph handling (after_compaction; only the compaction marker episode is appended)",
  "temporal before/after edges from LLM extraction",
  "tools not served by the service: brain_update_self_model, brain_reflect, brain_generate_skill, brain_workspace, brain_docs",
];

/** Optional service tool used for episode writes (sharpwave-server >= engram/server-episode-append). Internal plumbing: not exposed to the model. */
export const EPISODE_APPEND_TOOL = "brain_episode_append";

/** Tools the brain service serves (sharpwave-server SERVICE_TOOLS) that are proxied to the model. */
export const REMOTE_TOOL_NAMES = [
  "brain_query",
  "brain_write",
  "brain_link",
  "brain_supersede",
  "brain_stats",
  "brain_history",
  "brain_expand",
  "brain_review",
  "brain_forget",
  "brain_edges",
  "brain_reset",
] as const;

// Copied verbatim from sharpwave-core buildRecallContext so the injected block
// is byte-identical in shape to local mode.
export const RECALL_BLOCK_HEADER =
  "[BRAIN: on your mind — ·gist items are rough unattributed fragments; do not assert them as facts about Hailey without checking]";
export const REMOTE_BANNER =
  "[SharpWave remote] Memory is served by the SharpWave brain service; relevant memories (your private brain + shared) are pre-loaded below. Use brain_query for deep recall, brain_write to record new facts.";
export const REMOTE_DOWN_NOTICE =
  "[SharpWave remote] Brain service unavailable this turn — no memories were loaded; brain_* tools may fail until it recovers.";

const WARN_INTERVAL_MS = 60_000;
const HARVEST_INTERVAL_MS = 60 * 60 * 1000;
const HEALTH_BACKOFF_START_MS = 1_000;
const HEALTH_BACKOFF_MAX_MS = 60_000;
const HEALTH_MAX_ATTEMPTS = 12;

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };
type ToolContextLike = { agentId?: string; sessionKey?: string; sessionId?: string } | undefined;

export type RemoteHelpers = {
  resolveToolAgent: (tc: ToolContextLike) => { agentId: string } | { error: string };
  resolveAgentId: (event: unknown, hookCtx: unknown) => string;
  recordSessionAgent: (key: string | undefined, agentId: string) => void;
  clearSessionAgent: (key: string | undefined) => void;
  contextOptsFor: (agentId: string) => { externalMemoryActive: boolean };
  stripControlDirectives: (text: string) => string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = any;

function logFields(fields: Record<string, string | number | boolean | undefined>): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) filtered[k] = v;
  return `[openwave] ${JSON.stringify(filtered)}`;
}

/** Rate-limits a warning per key; reports how many were suppressed. */
export class WarnLimiter {
  private last = new Map<string, { at: number; suppressed: number }>();
  constructor(private readonly intervalMs = WARN_INTERVAL_MS, private readonly now: () => number = Date.now) {}
  /** Returns null when suppressed, else the number suppressed since the last emit. */
  take(key: string): number | null {
    const t = this.now();
    const s = this.last.get(key);
    if (s && t - s.at < this.intervalMs) { s.suppressed++; return null; }
    const suppressed = s?.suppressed ?? 0;
    this.last.set(key, { at: t, suppressed: 0 });
    return suppressed;
  }
  clear(): void { this.last.clear(); }
}

/** Mirrors sharpwave-server's published schema (SERVICE_TOOLS; pinned by test/remote/tool-results.test.ts): core's def minus writer_agent_id, plus visibility/scope/format. */
function remoteToolSchema(name: string): { description: string; parameters: Record<string, unknown> } {
  const base = BRAIN_TOOL_DEFS[name];
  const props: Record<string, unknown> = { ...((base?.inputSchema?.properties as Record<string, unknown>) ?? {}) };
  delete props["writer_agent_id"];
  delete props["agent"];
  const vis = { type: "string", enum: ["private", "shared"], description: 'Which brain: "private" (yours, default) or "shared" (visible to every agent; writing needs the shared-write scope).' };
  if (name === "brain_query") {
    props["scope"] = { type: "string", enum: ["all", "private", "shared"], description: 'Which brains to search: "all" (default: private + shared), "private", or "shared".' };
    props["format"] = { type: "string", enum: ["text", "json"], description: "Output format (default text)." };
  } else if (name === "brain_stats") {
    props["visibility"] = { type: "string", enum: ["all", "private", "shared"], description: "Which brain(s) to report (default all)." };
    props["format"] = { type: "string", enum: ["text", "json"], description: "Output format (default text)." };
  } else if (name === "brain_expand") {
    // The service also accepts format (text|json) here; keep the published schema in sync.
    props["visibility"] = { ...vis, description: "Which brain holds the node. Default: your private brain, then shared." };
    props["format"] = { type: "string", enum: ["text", "json"], description: "Output format (default text)." };
  } else {
    props["visibility"] = vis;
  }
  const descriptions: Record<string, string> = {
    brain_query: "Search your private brain and the shared brain on the SharpWave brain service. Results are merged and labelled [private] or [shared].",
    brain_write: 'Store a new memory in your private brain (default) or, with visibility:"shared" and the shared-write scope, in the shared brain. The writer is always your agent (stamped by the service).',
  };
  return {
    description: descriptions[name] ?? base?.description ?? name,
    parameters: {
      type: "object",
      properties: props,
      ...(base?.inputSchema?.required ? { required: base.inputSchema.required } : {}),
    },
  };
}

type QueryHit = { brain: "private" | "shared"; id: string; type: string; label: string; content: string; score: number; writer: string | null };

export function parseQueryJson(text: string): QueryHit[] {
  try {
    const body = JSON.parse(text) as { results?: QueryHit[] };
    return Array.isArray(body.results) ? body.results : [];
  } catch {
    return [];
  }
}

/** Same line format as core.buildRecallContext; shared hits carry a ·shared tag in the provenance slot. */
export function formatRecallBlock(hits: QueryHit[], surface: "voice" | "chat", externalMemoryActive: boolean): string {
  let rows = hits;
  // Graft A: when the host curated tier (MEMORY.md/USER.md) owns durable
  // identity/goals, don't inject them a second time from the graph.
  if (externalMemoryActive) rows = rows.filter((h) => h.type !== "identity" && h.type !== "goal");
  if (rows.length === 0) return "";
  const cap = surface === "voice" ? 3 : rows.length;
  const contentMax = surface === "voice" ? 120 : 200;
  const lines = rows.slice(0, cap).map((h) => {
    const tag = h.brain === "shared" ? "·shared" : "";
    return `[${h.type}${tag}] ${h.label}: ${String(h.content ?? "").slice(0, contentMax)}`;
  });
  return `${RECALL_BLOCK_HEADER}\n${lines.join("\n")}`;
}

type AgentConn = {
  agentId: string;
  client: RemoteBrainClient | null;
  tokenSource: TokenSource;
  status: BrainConnectionInfo["status"];
  lastError?: string;
  serviceAgentId?: string;
  /** Feature detection result for brain_episode_append (undefined = not yet known). */
  episodeAppend?: boolean;
};

export type RemoteRuntime = {
  settings: ResolvedRemoteSettings;
  conns: Map<string, AgentConn>;
  connectionInfo: () => BrainConnectionInfo;
  /** Resolves when the gateway_start health/auth check finishes (tests). */
  startupCheck: Promise<void> | null;
  /** Wait for in-flight fire-and-forget episode appends (tests / shutdown). */
  flushEpisodes: () => Promise<void>;
  stop: () => Promise<void>;
};

export function registerRemoteMode(
  api: Api,
  config: RemoteConfigFields & core.BrainConfig & { agents: string[] },
  log: Log,
  helpers: RemoteHelpers,
): RemoteRuntime {
  const settings = resolveRemoteSettings(config);
  const warn = new WarnLimiter();
  const conns = new Map<string, AgentConn>();
  const timers = { harvest: null as NodeJS.Timeout | null, health: null as NodeJS.Timeout | null };
  let stopped = false;

  // ── Token per served agent ────────────────────────────────────────────────
  const singleToken = tokenIsSingleAgent(config);
  config.agents.forEach((agentId, i) => {
    if (singleToken && i > 0) {
      conns.set(agentId, { agentId, client: null, tokenSource: "none", status: "misconfigured",
        lastError: "one token can only serve one agent; use brainTokenFile with {agentId} to serve several" });
      log.error(logFields({ agentId, op: "remote.token", outcome: "misconfigured", note: `remote mode serves only "${config.agents[0]}" with a single token; this agent gets no memory. Use brainTokenFile with {agentId}.` }));
      return;
    }
    const t = loadToken(config, agentId);
    if (!t.ok) {
      conns.set(agentId, { agentId, client: null, tokenSource: t.source, status: "misconfigured", lastError: t.reason });
      log.error(logFields({ agentId, op: "remote.token", outcome: "error", tokenSource: t.source, error: t.reason }));
      return;
    }
    if (t.source === "inline") {
      log.warn(logFields({ agentId, op: "remote.token", outcome: "ok", tokenSource: "inline", note: "brainToken is stored in openclaw.json; prefer brainTokenFile or $OPENWAVE_BRAIN_TOKEN" }));
    }
    conns.set(agentId, {
      agentId,
      tokenSource: t.source,
      status: "unknown",
      client: new RemoteBrainClient({ url: settings.url, token: t.token, timeoutMs: settings.timeoutMs, agentId, clientVersion: "openwave-remote" }),
    });
  });

  const reportFailure = (agentId: string, op: string, e: RemoteBrainError) => {
    const c = conns.get(agentId);
    if (c) {
      c.status = e.kind === "unauthorized" ? "unauthorized" : "unreachable";
      c.lastError = e.message;
    }
    const key = `${agentId}:${e.kind}`;
    const suppressed = warn.take(key);
    if (suppressed === null) return;
    if (e.kind === "unauthorized") {
      log.error(logFields({
        agentId, op, outcome: "unauthorized", status: e.status,
        error: `BAD BRAIN TOKEN: the brain service at ${settings.url} rejected the token for agent "${agentId}" (source=${c?.tokenSource ?? "?"}). Mint a new one with \`sharpwave-server token mint --agent <id>\` and update brainTokenFile. Memory is OFF for this agent until fixed.`,
        ...(suppressed ? { suppressed } : {}),
      }));
    } else {
      log.warn(logFields({ agentId, op, outcome: e.kind, error: e.message, url: settings.url, ...(suppressed ? { suppressed } : {}) }));
    }
  };

  const noteOk = (agentId: string) => {
    const c = conns.get(agentId);
    if (c && c.status !== "ok") {
      const was = c.status;
      c.status = "ok";
      delete c.lastError;
      if (was === "unreachable" || was === "unauthorized") {
        warn.clear();
        log.info(logFields({ agentId, op: "remote.recovered", outcome: "ok", url: settings.url }));
      }
    }
  };

  /** Call a tool for an agent; returns null (and logs, rate-limited) on transport/auth failure. Never throws. */
  const call = async (agentId: string, op: string, name: string, args: Record<string, unknown>) => {
    const c = conns.get(agentId);
    if (!c?.client) return null;
    try {
      const r = await c.client.callTool(name, args);
      noteOk(agentId);
      return r;
    } catch (err) {
      const e = err instanceof RemoteBrainError ? err : new RemoteBrainError("protocol", redact(String(err)));
      reportFailure(agentId, op, e);
      return null;
    }
  };

  // ── Tools: proxy to the service ───────────────────────────────────────────
  // Results go through brainToolResult so `details` carries the text: OpenClaw
  // Code Mode / catalog calls hand the model ONLY `details` (see tool-result.ts).
  for (const name of REMOTE_TOOL_NAMES) {
    const schema = remoteToolSchema(name);
    api.registerTool(
      (toolContext: ToolContextLike) => ({
        name,
        description: schema.description,
        parameters: schema.parameters,
        outputSchema: BRAIN_TOOL_OUTPUT_SCHEMA,
        async execute(_toolCallId: string, params: Record<string, unknown> | undefined) {
          const who = helpers.resolveToolAgent(toolContext);
          if ("error" in who) return brainToolResult(who.error, { isError: true });
          const conn = conns.get(who.agentId);
          if (!conn?.client) return brainToolResult(`openwave (remote mode): no brain service connection for agent "${who.agentId}": ${conn?.lastError ?? "not configured"}`, { isError: true });
          const r = await call(who.agentId, `tool.${name}`, name, params ?? {});
          if (!r) {
            const st = conns.get(who.agentId);
            return brainToolResult(st?.status === "unauthorized"
              ? `Error: the SharpWave brain service rejected this agent's token — memory is unavailable until the token is fixed.`
              : `Error: the SharpWave brain service is unreachable (${st?.lastError ?? "unknown error"}). Try again later.`, { isError: true });
          }
          return brainToolResult(r.text, { isError: r.isError });
        },
      }),
      { name },
    );
  }

  // ── Memory supplements ────────────────────────────────────────────────────
  try {
    api.registerMemoryPromptSupplement?.(() => [
      "[openwave] graph memory active (remote SharpWave brain service) — call brain_query for deep recall.",
    ]);
  } catch (err) {
    log.warn(logFields({ op: "registerMemoryPromptSupplement", outcome: "error", error: String(err) }));
  }
  try {
    api.registerMemoryCorpusSupplement?.({
      async search(params: { query: string; maxResults?: number; agentSessionKey?: string }) {
        const agentId = core.agentIdFromKey(params.agentSessionKey ?? "", config.agents);
        if (!config.agents.includes(agentId)) return [];
        const r = await call(agentId, "memoryCorpusSupplement.search", "brain_query", {
          query: params.query, limit: params.maxResults ?? 5, format: "json", scope: settings.sharedRecall ? "all" : "private",
        });
        if (!r || r.isError) return [];
        return parseQueryJson(r.text).map((h) => ({
          corpus: "openwave", path: `node:${h.id}`, title: h.label, kind: h.type, score: h.score, snippet: String(h.content ?? "").slice(0, 300), id: h.id,
        }));
      },
      async get() { return null; },
    });
  } catch (err) {
    log.warn(logFields({ op: "registerMemoryCorpusSupplement", outcome: "error", error: String(err) }));
  }

  // ── Episodes → service (brain_episode_append, feature-detected) ──────────
  // Mirrors local core.appendEpisode call sites. Fire-and-forget so a slow
  // service never delays a hook; each call is still bounded by timeoutMs.
  // If the service doesn't advertise the tool (older sharpwave-server), we keep
  // the previous behaviour: episodes are not stored (logged once per agent).
  const pendingEpisodes = new Set<Promise<void>>();
  const supportsEpisodes = async (agentId: string): Promise<boolean> => {
    const c = conns.get(agentId);
    if (!c?.client) return false;
    try {
      const names = await c.client.toolNames();
      const has = names.has(EPISODE_APPEND_TOOL);
      if (c.episodeAppend !== has) {
        log.info(logFields({
          agentId, op: "remote.episode_append", outcome: has ? "enabled" : "unsupported",
          ...(has ? {} : { note: "brain service does not advertise brain_episode_append; episodes are not stored (upgrade sharpwave-server)" }),
        }));
      }
      c.episodeAppend = has;
      noteOk(agentId);
      return has;
    } catch (err) {
      const e = err instanceof RemoteBrainError ? err : new RemoteBrainError("protocol", redact(String(err)));
      reportFailure(agentId, "remote.episode_append.detect", e);
      return false;
    }
  };
  const appendEpisodeRemote = (agentId: string, sessionId: string, role: "user" | "assistant" | "tool", content: string, importance: number): void => {
    const conn = conns.get(agentId);
    if (!conn?.client || conn.episodeAppend === false) return;
    const p = (async () => {
      if (!(await supportsEpisodes(agentId))) return;
      const r = await call(agentId, "remote.episode_append", EPISODE_APPEND_TOOL, {
        session_id: sessionId || "unknown", role, content: content.slice(0, 32_000), importance: Math.max(0, Math.min(1, importance)),
      });
      if (r?.isError) {
        const suppressed = warn.take(`${agentId}:episode_rejected`);
        if (suppressed !== null) log.warn(logFields({ agentId, op: "remote.episode_append", outcome: "rejected", error: r.text.slice(0, 200), ...(suppressed ? { suppressed } : {}) }));
      }
    })().catch(() => { /* call() never throws; belt and braces */ });
    pendingEpisodes.add(p);
    void p.finally(() => pendingEpisodes.delete(p));
  };

  // ── Extraction → service ──────────────────────────────────────────────────
  const harvesting = new Set<string>();
  const harvestToService = async (agentId: string, opPrefix: string): Promise<number> => {
    if (harvesting.has(agentId)) return 0;
    harvesting.add(agentId);
    let written = 0;
    try {
      const facts = await core.drainExtractionQueue(agentId, config, log);
      for (const fact of facts) {
        const r = await call(agentId, `${opPrefix}.extraction_write`, "brain_write", {
          type: fact.type, label: fact.label, content: fact.content, importance: fact.importance,
        });
        if (!r) break; // service down: stop (the remaining facts are dropped, as a failed local harvest would)
        if (r.isError) log.warn(logFields({ agentId, op: `${opPrefix}.extraction_write`, outcome: "rejected", error: r.text.slice(0, 200) }));
        else written++;
      }
      if (written > 0) log.info(logFields({ agentId, op: `${opPrefix}.facts_written`, outcome: "ok", count: written, target: "remote" }));
    } catch (err) {
      log.warn(logFields({ agentId, op: `${opPrefix}.extraction`, outcome: "error", error: String(err) }));
    } finally {
      harvesting.delete(agentId);
    }
    return written;
  };

  const queueForExtraction = (agentId: string, sessionId: string, role: "user" | "assistant", content: string, importance: number) => {
    if (!config.llmExtractionEnabled || importance < config.llmExtractionMinImportance) return;
    core.queueEpisodeForExtraction(agentId, {
      id: `remote-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      session_id: sessionId, role, content, importance,
      tokens: Math.ceil(content.length / 4), ripple_count: 0, created_at: Date.now(), meta: null,
    } as Parameters<typeof core.queueEpisodeForExtraction>[1]);
  };

  // ── Startup health check with backoff ─────────────────────────────────────
  const verifyTokens = async () => {
    for (const c of conns.values()) {
      if (!c.client) continue;
      c.client.clearBackoff();
      const r = await call(c.agentId, "remote.auth_check", "brain_stats", { format: "json" });
      if (!r) continue;
      if (r.isError) {
        c.status = "unauthorized";
        c.lastError = r.text.slice(0, 200);
        log.error(logFields({ agentId: c.agentId, op: "remote.auth_check", outcome: "forbidden", error: c.lastError }));
        continue;
      }
      try { c.serviceAgentId = (JSON.parse(r.text) as { agentId?: string }).agentId; } catch { /* text format */ }
      await supportsEpisodes(c.agentId);
      log.info(logFields({
        agentId: c.agentId, op: "remote.auth_check", outcome: "ok", serviceAgentId: c.serviceAgentId,
        ...(c.serviceAgentId && c.serviceAgentId !== c.agentId ? { note: `token belongs to service agent "${c.serviceAgentId}"; writes are stamped with that id` } : {}),
      }));
    }
  };

  const runStartupCheck = (): Promise<void> => new Promise<void>((resolveCheck) => {
    let attempt = 0;
    let delay = HEALTH_BACKOFF_START_MS;
    const tick = async () => {
      timers.health = null;
      if (stopped) return resolveCheck();
      attempt++;
      const h = await checkHealth(settings.url, settings.timeoutMs);
      if (stopped) return resolveCheck();
      if (h.ok) {
        log.info(logFields({ op: "remote.health", outcome: "ok", url: settings.url, version: h.version, attempt }));
        await verifyTokens().catch(() => {});
        return resolveCheck();
      }
      for (const c of conns.values()) if (c.client) { c.status = "unreachable"; c.lastError = h.error; }
      if (attempt >= HEALTH_MAX_ATTEMPTS) {
        log.error(logFields({ op: "remote.health", outcome: "giving_up", url: settings.url, attempts: attempt, error: h.error, note: "turns proceed without memory; each call retries with backoff" }));
        return resolveCheck();
      }
      const suppressed = warn.take("health");
      if (suppressed !== null) {
        log.warn(logFields({ op: "remote.health", outcome: "unreachable", url: settings.url, attempt, retryInMs: delay, error: h.error }));
      }
      timers.health = setTimeout(() => void tick(), delay);
      timers.health.unref?.();
      delay = Math.min(HEALTH_BACKOFF_MAX_MS, delay * 2);
    };
    void tick();
  });

  const runtime: RemoteRuntime = {
    settings,
    conns,
    startupCheck: null,
    flushEpisodes: async () => { while (pendingEpisodes.size) await Promise.all([...pendingEpisodes]); },
    connectionInfo: () => {
      const all = [...conns.values()];
      const first = all[0];
      const worst = all.find((c) => c.status === "unauthorized") ?? all.find((c) => c.status === "misconfigured")
        ?? all.find((c) => c.status === "unreachable") ?? first;
      return {
        brainMode: "remote",
        brainUrl: settings.url,
        sharedRecall: settings.sharedRecall,
        remoteTimeoutMs: settings.timeoutMs,
        tokenSource: first?.tokenSource ?? "none",
        status: worst?.status ?? "misconfigured",
        ...(worst?.lastError ? { lastError: worst.lastError } : {}),
        ...(first?.episodeAppend !== undefined ? { episodeAppend: first.episodeAppend } : {}),
        disabledInRemoteMode: [...REMOTE_DISABLED_FEATURES],
      };
    },
    stop: async () => {
      stopped = true;
      await Promise.race([
        Promise.all([...pendingEpisodes]),
        new Promise((r) => { const t = setTimeout(r, settings.timeoutMs); t.unref?.(); }),
      ]);
      if (timers.harvest) { clearInterval(timers.harvest); timers.harvest = null; }
      if (timers.health) { clearTimeout(timers.health); timers.health = null; }
      for (const c of conns.values()) await c.client?.close().catch(() => {});
    },
  };

  // ── Hooks ─────────────────────────────────────────────────────────────────
  api.on("gateway_start", async (_event: unknown, ctx: { getCron?: () => CronService | undefined }) => {
    stopped = false;
    log.info(logFields({ op: "gateway_start", outcome: "start", brainMode: "remote", url: settings.url }));
    // The service owns sleep: make sure openwave's consolidation cron is NOT
    // registered (remove one left behind by local mode). Never add it here.
    try {
      const cron = ctx?.getCron?.();
      if (cron) {
        const existing = await cron.list({ includeDisabled: true });
        for (const job of existing) {
          if (job?.id === CONSOLIDATION_CRON_ID || job?.name === CONSOLIDATION_CRON_ID) {
            await cron.remove(job.id ?? job.name!);
            log.info(logFields({ op: "cron.consolidation", outcome: "removed", reason: "brainMode=remote (service owns sleep)" }));
          }
        }
      }
    } catch (err) {
      log.warn(logFields({ op: "cron.consolidation", outcome: "error", error: String(err) }));
    }
    if (timers.harvest) clearInterval(timers.harvest);
    if (config.llmExtractionEnabled) {
      timers.harvest = setInterval(() => {
        for (const agentId of config.agents) void harvestToService(agentId, "harvest_tick");
      }, HARVEST_INTERVAL_MS);
      timers.harvest.unref?.();
    }
    // Non-blocking: gateway start never waits on the brain service.
    runtime.startupCheck = runStartupCheck();
    log.info(logFields({ op: "gateway_start", outcome: "ready", brainMode: "remote", localSleep: false, consolidationCron: false }));
  });

  api.on("gateway_stop", async () => {
    await runtime.stop();
    log.info(logFields({ op: "gateway_stop", outcome: "ok", brainMode: "remote" }));
  });

  try {
    api.lifecycle.registerRuntimeLifecycle({
      id: "openwave",
      description: "openwave host-state cleanup (remote brain mode)",
      cleanup: async (ctx: { reason: string }) => {
        await runtime.stop();
        log.info(logFields({ op: "lifecycle.cleanup", outcome: "ok", reason: ctx.reason, brainMode: "remote" }));
      },
    });
  } catch (err) {
    log.warn(logFields({ op: "registerRuntimeLifecycle", outcome: "error", error: String(err) }));
  }

  const recordHook = (agentId: string, hookCtx: { sessionKey?: string; sessionId?: string } | undefined, event?: { sessionKey?: string; sessionId?: string }) => {
    helpers.recordSessionAgent(event?.sessionId ?? hookCtx?.sessionId, agentId);
    helpers.recordSessionAgent(event?.sessionKey ?? hookCtx?.sessionKey, agentId);
  };

  api.on("session_start", async (event: { sessionId?: string; sessionKey?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
    const agentId = helpers.resolveAgentId(event, hookCtx);
    if (!config.agents.includes(agentId)) return;
    recordHook(agentId, hookCtx, event);
    const sessionKey = event?.sessionKey ?? hookCtx?.sessionKey ?? "";
    appendEpisodeRemote(agentId, sessionKey, "tool", `[session start: ${sessionKey}]`, 0.1);
  }, { priority: 0, timeoutMs: 200 });

  api.on("session_end", async (event: { sessionId?: string; sessionKey?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
    const agentId = helpers.resolveAgentId(event, hookCtx);
    if (!config.agents.includes(agentId)) return;
    const endKey = event?.sessionKey ?? hookCtx?.sessionKey ?? "";
    appendEpisodeRemote(agentId, endKey, "tool", `[session end: ${endKey}]`, 0.1);
    await harvestToService(agentId, "session_end");
    helpers.clearSessionAgent(event?.sessionId ?? hookCtx?.sessionId);
    helpers.clearSessionAgent(event?.sessionKey ?? hookCtx?.sessionKey);
  });

  api.on("agent_turn_prepare", async (_event: unknown, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
    const agentId = helpers.resolveAgentId(undefined, hookCtx);
    if (!config.agents.includes(agentId)) return;
    recordHook(agentId, hookCtx);
  }, { priority: 0, timeoutMs: 200 });

  api.on("before_prompt_build", async (event: { prompt?: string; messages?: Array<{ role?: string; content?: unknown }>; kind?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
    try {
      const t0 = Date.now();
      const agentId = helpers.resolveAgentId(undefined, hookCtx);
      if (!config.agents.includes(agentId)) return;
      if (event?.kind === "heartbeat") return;
      const sessionKey = hookCtx?.sessionKey ?? "";
      if (sessionKey.endsWith(":heartbeat")) return;
      recordHook(agentId, hookCtx);
      const surface: "voice" | "chat" = sessionKey.startsWith("voice:") ? "voice" : "chat";

      let query = typeof event?.prompt === "string" ? event.prompt : "";
      if (!query) {
        const messages = event?.messages ?? [];
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]!;
          if (m.role === "user" && typeof m.content === "string") { query = m.content; break; }
        }
      }

      const conn = conns.get(agentId);
      if (!conn?.client) {
        return surface === "voice" ? undefined : { appendSystemContext: REMOTE_DOWN_NOTICE };
      }
      let block = "";
      let down = false;
      if (query && query.length >= 3) {
        const r = await call(agentId, "before_prompt_build.recall", "brain_query", {
          query: query.slice(0, 2000),
          limit: config.recallTopK ?? 10,
          format: "json",
          scope: settings.sharedRecall ? "all" : "private",
        });
        if (!r) down = true;
        else if (r.isError) log.debug?.(logFields({ agentId, op: "before_prompt_build.recall", outcome: "tool_error", error: r.text.slice(0, 200) }));
        else block = formatRecallBlock(parseQueryJson(r.text), surface, helpers.contextOptsFor(agentId).externalMemoryActive);
      } else if (conn.status === "unreachable" || conn.status === "unauthorized") {
        down = true;
      }

      const result: { appendSystemContext?: string; prependContext?: string } = {};
      if (surface !== "voice") result.appendSystemContext = down ? REMOTE_DOWN_NOTICE : REMOTE_BANNER;
      if (block) result.prependContext = block;
      log.debug?.(logFields({ agentId, op: "before_prompt_build", outcome: down ? "degraded" : "ok", brainMode: "remote", durationMs: Date.now() - t0, prependChars: block.length }));
      if (!result.appendSystemContext && !result.prependContext) return;
      return result;
    } catch (err) {
      log.warn(logFields({ op: "before_prompt_build", outcome: "error", brainMode: "remote", error: redact(String(err)) }));
      return;
    }
  }, { priority: 0, timeoutMs: settings.timeoutMs + 1000 });

  api.on("message_received", async (event: { content?: string; text?: string; sessionKey?: string; agentId?: string; senderId?: string; from?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string; channelId?: string }) => {
    try {
      const agentId = helpers.resolveAgentId(event, hookCtx);
      if (!config.agents.includes(agentId)) return;
      const content = event?.content ?? event?.text ?? "";
      if (!content) return;
      const sessionKey = event?.sessionKey ?? hookCtx?.sessionKey ?? "";
      const sessionId = hookCtx?.sessionId ?? sessionKey;
      recordHook(agentId, hookCtx, event);
      const isCron = /^agent:[^:]+:cron:/.test(sessionKey) || sessionKey.startsWith("cron:");
      const owners = readOwnerAllowFrom(api.runtime?.config?.current?.());
      const origin = classifyOrigin({ channelId: hookCtx?.channelId, senderId: event?.senderId, from: event?.from, sessionKey }, owners);
      const scored = isCron ? 0.1 : core.scoreImportance("user", content);
      const importance = owners.length === 0 ? scored : capImportance(origin, scored, config.llmExtractionMinImportance);
      appendEpisodeRemote(agentId, sessionKey, "user", content, importance);
      queueForExtraction(agentId, sessionId, "user", content, importance);
    } catch (err) {
      log.debug?.(logFields({ op: "message_received", outcome: "error", brainMode: "remote", error: String(err) }));
    }
  });

  api.on("llm_output", async (event: { assistantTexts?: string[]; content?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
    try {
      const agentId = helpers.resolveAgentId(undefined, hookCtx);
      if (!config.agents.includes(agentId)) return;
      const texts = event?.assistantTexts ?? (event?.content ? [event.content] : []);
      const content = helpers.stripControlDirectives(texts.join("\n").trim());
      if (!content) return;
      const sessionKey = hookCtx?.sessionKey ?? hookCtx?.sessionId ?? "";
      const sessionId = hookCtx?.sessionId ?? sessionKey;
      const isCron = /^agent:[^:]+:cron:/.test(sessionKey) || sessionKey.startsWith("cron:");
      const importance = isCron ? 0.1 : core.scoreImportance("assistant", content);
      appendEpisodeRemote(agentId, sessionKey, "assistant", content, importance);
      queueForExtraction(agentId, sessionId, "assistant", content, importance);
    } catch (err) {
      log.debug?.(logFields({ op: "llm_output", outcome: "error", brainMode: "remote", error: String(err) }));
    }
  });

  api.on("after_compaction", async (event: { compactedCount?: number; messageCount?: number }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
    try {
      const agentId = helpers.resolveAgentId(undefined, hookCtx);
      if (!config.agents.includes(agentId)) return;
      const sessionKey = hookCtx?.sessionKey ?? hookCtx?.sessionId ?? "";
      appendEpisodeRemote(agentId, sessionKey, "tool", `[compaction: ${event?.compactedCount ?? 0} of ${event?.messageCount ?? 0} messages compacted]`, 0.1);
    } catch { /* never fail a hook */ }
  });

  log.info(logFields({
    op: "register", outcome: "ok", brainMode: "remote", url: settings.url, agents: config.agents.length,
    tools: REMOTE_TOOL_NAMES.length, sharedRecall: settings.sharedRecall, timeoutMs: settings.timeoutMs,
    tokenSources: [...conns.values()].map((c) => `${c.agentId}:${c.tokenSource}`).join(","),
    disabled: REMOTE_DISABLED_FEATURES.length,
  }));

  return runtime;
}
