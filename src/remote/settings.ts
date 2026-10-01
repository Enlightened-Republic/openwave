// Remote brain mode: config resolution and token loading.
//
// `brainMode: "remote"` makes openwave talk to the SharpWave brain service
// (sharpwave-server, MCP Streamable HTTP) instead of opening brain.db
// in-process. Everything here is pure (no I/O except reading the token file)
// so it can be unit-tested and so register() can resolve settings without
// touching the network.
//
// SECURITY: the token value must never be logged, returned from a session
// action, or included in an error message. Only its SOURCE ("file", "env",
// "inline", "none") is ever surfaced.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export type BrainMode = "local" | "remote";

export const DEFAULT_BRAIN_URL = "http://127.0.0.1:18790";
export const DEFAULT_REMOTE_TIMEOUT_MS = 2500;
export const TOKEN_ENV_VAR = "OPENWAVE_BRAIN_TOKEN";

/** The remote-mode keys in plugins.entries.openwave.config. */
export type RemoteConfigFields = {
  brainMode?: BrainMode;
  brainUrl?: string;
  /** Path to a file holding the bearer token. May contain `{agentId}` to give each served agent its own token. Preferred. */
  brainTokenFile?: string;
  /** Inline token. Discouraged (lands in openclaw.json); prefer brainTokenFile or $OPENWAVE_BRAIN_TOKEN. */
  brainToken?: string;
  /** Include the shared brain in per-turn recall. Default true. */
  sharedRecall?: boolean;
  /** Per-request budget for calls to the brain service (ms). Default 2500. */
  remoteTimeoutMs?: number;
};

export type TokenSource = "file" | "env" | "inline" | "none";

export type ResolvedRemoteSettings = {
  mode: BrainMode;
  url: string;
  sharedRecall: boolean;
  timeoutMs: number;
  tokenFile?: string;
};

export function resolveBrainMode(cfg: RemoteConfigFields): BrainMode {
  return cfg.brainMode === "remote" ? "remote" : "local";
}

export function resolveRemoteSettings(cfg: RemoteConfigFields): ResolvedRemoteSettings {
  const rawUrl = typeof cfg.brainUrl === "string" && cfg.brainUrl.trim() ? cfg.brainUrl.trim() : DEFAULT_BRAIN_URL;
  const t = Number(cfg.remoteTimeoutMs);
  return {
    mode: resolveBrainMode(cfg),
    url: rawUrl.replace(/\/+$/, ""),
    sharedRecall: cfg.sharedRecall !== false,
    timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(Math.max(t, 100), 30_000) : DEFAULT_REMOTE_TIMEOUT_MS,
    ...(typeof cfg.brainTokenFile === "string" && cfg.brainTokenFile.trim() ? { tokenFile: cfg.brainTokenFile.trim() } : {}),
  };
}

export function expandTokenPath(p: string, agentId: string): string {
  let out = p.replace(/\{agentId\}/g, agentId);
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) out = homedir() + out.slice(1);
  out = out.replace(/\$\{HOME\}|%USERPROFILE%/g, homedir());
  return out;
}

export type TokenResult =
  | { ok: true; token: string; source: TokenSource }
  | { ok: false; source: TokenSource; reason: string };

/**
 * Resolve the bearer token for one served agent. Precedence:
 *   1. brainTokenFile (path; `{agentId}` placeholder supported)
 *   2. $OPENWAVE_BRAIN_TOKEN
 *   3. brainToken (inline)
 * A configured-but-unreadable token file is an error; it does NOT silently fall
 * through to the env var, so a typo in the path is visible.
 */
export function loadToken(cfg: RemoteConfigFields, agentId: string, env: NodeJS.ProcessEnv = process.env): TokenResult {
  if (typeof cfg.brainTokenFile === "string" && cfg.brainTokenFile.trim()) {
    const path = expandTokenPath(cfg.brainTokenFile.trim(), agentId);
    try {
      const token = readFileSync(path, "utf8").trim();
      if (!token) return { ok: false, source: "file", reason: `brainTokenFile is empty: ${path}` };
      if (/\s/.test(token)) return { ok: false, source: "file", reason: `brainTokenFile must contain only the token (found whitespace): ${path}` };
      return { ok: true, token, source: "file" };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "error";
      return { ok: false, source: "file", reason: `cannot read brainTokenFile (${code}): ${path}` };
    }
  }
  const fromEnv = env[TOKEN_ENV_VAR]?.trim();
  if (fromEnv) return { ok: true, token: fromEnv, source: "env" };
  if (typeof cfg.brainToken === "string" && cfg.brainToken.trim()) return { ok: true, token: cfg.brainToken.trim(), source: "inline" };
  return { ok: false, source: "none", reason: `no brain token: set brainTokenFile, $${TOKEN_ENV_VAR}, or brainToken` };
}

/** True when one token source can only identify a single agent (no {agentId} placeholder). */
export function tokenIsSingleAgent(cfg: RemoteConfigFields): boolean {
  return !(typeof cfg.brainTokenFile === "string" && cfg.brainTokenFile.includes("{agentId}"));
}

/** Scrub anything that looks like a sharpwave token from a string before logging. */
export function redact(s: string, token?: string): string {
  let out = s;
  if (token) out = out.split(token).join("[REDACTED]");
  return out.replace(/swt_[A-Za-z0-9_\-]+/g, "swt_[REDACTED]").replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
