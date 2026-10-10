// Dynamic agent roster + auto-provisioning (remote brain mode).
//
//   agents: "*"        serve every agent in OpenClaw's live config (agents.list /
//                      agents.entries), minus `excludeAgents`. The roster is read
//                      from api.runtime.config.current() on demand, so an agent
//                      added with `openclaw agents add` (a hot-applied config
//                      change, no gateway restart) is served on its first turn.
//   autoProvision      when an served agent has no token file, call the brain
//                      service's brain_provision_agent with the provisioner token
//                      (provisionTokenFile; needs only the narrow `provision`
//                      scope), write the returned token to brainTokenFile
//                      ({agentId} expanded) and connect immediately.
//
// SECURITY: the provisioner token and every minted token are never logged or
// returned; only token ids / statuses are surfaced.

import { existsSync, mkdirSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { RemoteBrainClient, RemoteBrainError } from "./client.js";
import { expandTokenPath, loadToken, redact, type RemoteConfigFields } from "./settings.js";

export const ALL_AGENTS = "*";
/** Same rule as sharpwave-server AGENT_ID_RE + reserved names. */
export const AGENT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const RESERVED = new Set(["shared", "_system", "backups", "audit"]);

export type AgentsSpec = string[] | typeof ALL_AGENTS;

export type AutoAgentsConfig = {
  agents?: AgentsSpec;
  /** Alias for agents: "*". */
  autoAgents?: boolean;
  /** Agent ids never served (dynamic and explicit modes). */
  excludeAgents?: string[];
  /** Provision brains + tokens for served agents that have no token file. Remote mode only. */
  autoProvision?: boolean;
  /** Token file holding a `provision`-scoped (or admin) service token. */
  provisionTokenFile?: string;
  /** How often (ms) to re-read the roster in the background so new agents are provisioned before their first turn. Default 30000; 0 disables (per-turn provisioning still works). */
  rosterPollMs?: number;
};

export function isDynamicAgents(cfg: AutoAgentsConfig): boolean {
  return cfg.agents === ALL_AGENTS || cfg.autoAgents === true;
}

export function validAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id) && !RESERVED.has(id.toLowerCase());
}

type RosterEntry = { id: string; name?: string };

/** Agents in an OpenClaw config snapshot (agents.entries map or agents.list array; legacy = ["main"]). */
export function listConfiguredAgents(ocConfig: unknown): RosterEntry[] {
  const agents = (ocConfig as { agents?: { list?: unknown; entries?: unknown } } | undefined)?.agents;
  const out: RosterEntry[] = [];
  const add = (id: unknown, e: unknown) => {
    if (typeof id !== "string" || !id.trim()) return;
    const norm = id.trim().toLowerCase();
    if (out.some((x) => x.id === norm)) return;
    const ent = (e ?? {}) as { name?: unknown; identity?: { name?: unknown } };
    const name = typeof ent.name === "string" ? ent.name : typeof ent.identity?.name === "string" ? ent.identity.name : undefined;
    out.push({ id: norm, ...(name ? { name } : {}) });
  };
  if (agents && typeof agents.entries === "object" && agents.entries) {
    for (const [id, e] of Object.entries(agents.entries as Record<string, unknown>)) add(id, e);
  } else if (agents && Array.isArray(agents.list)) {
    for (const e of agents.list) add((e as { id?: unknown })?.id, e);
  } else if (!agents || (!("list" in agents) && !("entries" in agents))) {
    out.push({ id: "main" });
  }
  return out;
}

/** Resolves the served agent set; dynamic mode re-reads the live OpenClaw config on every call. */
export class AgentRoster {
  readonly dynamic: boolean;
  private readonly exclude: Set<string>;
  constructor(private readonly cfg: AutoAgentsConfig & { agents?: AgentsSpec }, private readonly currentConfig: () => unknown) {
    this.dynamic = isDynamicAgents(cfg);
    this.exclude = new Set((cfg.excludeAgents ?? []).map((s) => String(s).trim().toLowerCase()));
  }
  excluded(id: string): boolean { return this.exclude.has(id.toLowerCase()); }
  entries(): RosterEntry[] {
    if (!this.dynamic) {
      const list = Array.isArray(this.cfg.agents) ? this.cfg.agents : [];
      return list.filter((id) => !this.excluded(id)).map((id) => ({ id }));
    }
    let snap: unknown;
    try { snap = this.currentConfig(); } catch { snap = undefined; }
    return listConfiguredAgents(snap).filter((e) => !this.excluded(e.id) && validAgentId(e.id));
  }
  ids(): string[] { return this.entries().map((e) => e.id); }
  has(id: string): boolean { return this.ids().includes(id); }
  name(id: string): string | undefined { return this.entries().find((e) => e.id === id)?.name; }
}

export type ProvisionOutcome =
  | { status: "provisioned" | "rotated"; tokenId: string }
  | { status: "already-provisioned"; tokenIds: string[] }
  | { status: "error"; error: string; retryable: boolean };

/** Write a token file atomically with owner-only permissions. */
export function writeTokenFileSecure(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  // POSIX: 0600. Windows: mode bits are ignored; the file inherits the tokens
  // folder ACL, which the runbook restricts with
  //   icacls <tokens> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
  // so a file created inside it is owner(+SYSTEM)-only without spawning icacls here.
  writeFileSync(tmp, token + "\n", { mode: 0o600, flag: "wx" });
  try { chmodSync(tmp, 0o600); } catch { /* windows */ }
  renameSync(tmp, path);
}

type Log = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };

const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Calls brain_provision_agent and writes the token file. One in-flight attempt
 * per agent; failures back off exponentially per agent (2s → 5min) so a down
 * service is not hammered and never blocks a turn for longer than one call.
 */
export class Provisioner {
  private client: RemoteBrainClient | null = null;
  private clientError: string | null = null;
  private inflight = new Map<string, Promise<ProvisionOutcome>>();
  private backoff = new Map<string, { until: number; delay: number }>();

  constructor(
    private readonly cfg: RemoteConfigFields & AutoAgentsConfig,
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly log: Log,
    private readonly fmt: (f: Record<string, string | number | boolean | undefined>) => string,
    private readonly now: () => number = Date.now,
  ) {}

  enabled(): boolean { return this.cfg.autoProvision === true; }

  tokenPath(agentId: string): string | null {
    const t = this.cfg.brainTokenFile;
    if (typeof t !== "string" || !t.includes("{agentId}")) return null;
    return expandTokenPath(t.trim(), agentId);
  }

  needsToken(agentId: string): boolean {
    const p = this.tokenPath(agentId);
    return !!p && !existsSync(p);
  }

  private getClient(): RemoteBrainClient | null {
    if (this.client) return this.client;
    if (typeof this.cfg.provisionTokenFile !== "string" || !this.cfg.provisionTokenFile.trim()) {
      this.clientError = "autoProvision needs provisionTokenFile";
      return null;
    }
    const t = loadToken({ brainTokenFile: this.cfg.provisionTokenFile }, "_provisioner");
    if (!t.ok) { this.clientError = t.reason; return null; }
    this.clientError = null;
    this.client = new RemoteBrainClient({ url: this.url, token: t.token, timeoutMs: Math.max(this.timeoutMs, 5000), agentId: "_provisioner", clientVersion: "openwave-provisioner" });
    return this.client;
  }

  /** Provision one agent if it has no token file. Never throws; never logs a token. */
  ensure(agentId: string, name?: string): Promise<ProvisionOutcome> {
    const running = this.inflight.get(agentId);
    if (running) return running;
    const p = this.run(agentId, name).finally(() => this.inflight.delete(agentId));
    this.inflight.set(agentId, p);
    return p;
  }

  private async run(agentId: string, name?: string): Promise<ProvisionOutcome> {
    if (!validAgentId(agentId)) return { status: "error", error: `invalid agent id "${agentId}"`, retryable: false };
    const path = this.tokenPath(agentId);
    if (!path) return { status: "error", error: "autoProvision needs brainTokenFile with an {agentId} placeholder", retryable: false };
    if (existsSync(path)) return { status: "already-provisioned", tokenIds: [] };
    const b = this.backoff.get(agentId);
    if (b && this.now() < b.until) return { status: "error", error: `provisioning backing off (${Math.ceil((b.until - this.now()) / 1000)}s)`, retryable: true };
    const client = this.getClient();
    if (!client) {
      this.log.error(this.fmt({ agentId, op: "provision", outcome: "misconfigured", error: this.clientError ?? "no provisioner token" }));
      return this.fail(agentId, this.clientError ?? "no provisioner token", false);
    }
    const label = `${agentId}${name ? ` (${name})` : ""} via OpenWave`.replace(/[^\p{L}\p{N} ()._,:@'\/-]/gu, "").slice(0, 120);
    try {
      const r = await client.callTool("brain_provision_agent", { agentId, label });
      if (r.isError) {
        const msg = redact(r.text).slice(0, 300);
        const retryable = /rate limit|max agents/i.test(msg);
        this.log.error(this.fmt({ agentId, op: "provision", outcome: "refused", error: msg }));
        return this.fail(agentId, msg, retryable);
      }
      const out = JSON.parse(r.text) as { status: string; token?: string; tokenId?: string; tokenIds?: string[] };
      if ((out.status === "provisioned" || out.status === "rotated") && typeof out.token === "string") {
        writeTokenFileSecure(path, out.token);
        this.backoff.delete(agentId);
        this.log.info(this.fmt({ agentId, op: "provision", outcome: out.status, tokenId: out.tokenId, tokenFile: path }));
        return { status: out.status, tokenId: out.tokenId ?? "?" };
      }
      if (out.status === "already-provisioned") {
        // The service has a live token for this agent but the file is gone: we can't recover the plaintext.
        const msg = `the brain service already has a token for "${agentId}" (${(out.tokenIds ?? []).join(",")}) but ${path} is missing. ` +
          `Restore the file, or rotate: sharpwave-server token revoke <id> then let openwave re-provision.`;
        this.log.error(this.fmt({ agentId, op: "provision", outcome: "token_file_missing", error: msg }));
        return this.fail(agentId, msg, false, { status: "already-provisioned", tokenIds: out.tokenIds ?? [] });
      }
      return this.fail(agentId, `unexpected provision response status "${out.status}"`, true);
    } catch (err) {
      const e = err instanceof RemoteBrainError ? err : new RemoteBrainError("protocol", redact(String(err)));
      const retryable = e.kind !== "unauthorized";
      this.log.warn(this.fmt({ agentId, op: "provision", outcome: e.kind, error: redact(e.message).slice(0, 200), note: retryable ? "will retry with backoff" : "provisioner token rejected" }));
      if (e.kind === "unauthorized") { await this.client?.close().catch(() => {}); this.client = null; }
      return this.fail(agentId, e.message, retryable);
    }
  }

  private fail(agentId: string, error: string, retryable: boolean, ret?: ProvisionOutcome): ProvisionOutcome {
    const prev = this.backoff.get(agentId);
    const delay = retryable ? Math.min(BACKOFF_MAX_MS, prev ? prev.delay * 2 : BACKOFF_START_MS) : BACKOFF_MAX_MS;
    this.backoff.set(agentId, { until: this.now() + delay, delay });
    return ret ?? { status: "error", error: redact(error), retryable };
  }

  async close(): Promise<void> { await this.client?.close().catch(() => {}); this.client = null; }
}
