// Engram Graft A+B helpers used by index.ts.
import { hasExternalMemoryCoreWorkspace } from "./memory-detection.js";
import { runConsolidationPass, type ConfigSource } from "./scheduler.js";

export const CONSOLIDATION_CRON_ID = "openwave:consolidation";
export const DEFAULT_CONSOLIDATION_CRON = "30 4 * * *";
/**
 * Wake mode for the consolidation job. The job exists only so the host's cron
 * store shows the cadence and `cron_changed` ticks the in-process pass; it must
 * never start an agent turn by itself. OpenClaw (2026.9.8, cron service
 * `waitsForAgent`) treats a main-session systemEvent job with wakeMode "now" as
 * agent work: it enqueues the event AND requests an immediate heartbeat, i.e. a
 * nightly LLM turn for nothing (the same waste the F-1 audit removed from the
 * legacy clawbrain-v4 jobs). "next-heartbeat" only enqueues the event.
 */
export const CONSOLIDATION_WAKE_MODE = "next-heartbeat";
const CONSOLIDATION_EVENT_TEXT =
  "[xanima:consolidation] Memory consolidation window (the xanima plugin runs it in-process; nothing to do).";

type Log = { info: (m: string) => void; warn: (m: string) => void };

function logFields(fields: Record<string, string | number | boolean | undefined>): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) filtered[k] = v;
  }
  return `[xanima] ${JSON.stringify(filtered)}`;
}

export type GraftConfig = {
  agents: string[];
  curatedTierDedupe?: boolean;
  consolidationCron?: string;
  consolidationCronEnabled?: boolean;
};

export type CronService = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<Array<{ id?: string; name?: string; wakeMode?: string }>>;
  add: (input: {
    name: string;
    description: string;
    enabled: boolean;
    schedule: { kind: string; expr: string; tz?: string };
    sessionTarget: string;
    wakeMode: string;
    payload:
      | { kind: "systemEvent"; text: string }
      | { kind: "agentTurn"; message: string; model?: string };
  }) => Promise<unknown>;
  update: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};

/**
 * Graft A: detect the host curated memory tier -> xanima-core context opts.
 * `hostConfig` is the live OpenClaw config (api.runtime.config.current()); it is
 * what runtime.agent.resolveAgentWorkspaceDir expects, not openwave's own config.
 * `cfg.curatedTierDedupe === false` disables the dedupe entirely.
 */
export function assemblyOptsFor(
  api: object,
  cfg: GraftConfig,
  agentId: string,
  hostConfig: unknown,
): { externalMemoryActive: boolean } {
  if (cfg.curatedTierDedupe === false) return { externalMemoryActive: false };
  return {
    externalMemoryActive: hasExternalMemoryCoreWorkspace(
      api as Parameters<typeof hasExternalMemoryCoreWorkspace>[0],
      hostConfig,
      agentId,
    ),
  };
}

/**
 * Graft B: idempotently register host cron openwave:consolidation.
 * A job left behind by an older plugin version with wakeMode "now" is switched
 * to CONSOLIDATION_WAKE_MODE in place so it stops waking the agent every night.
 * Still registers when dreaming is disabled (Telegram-temp).
 */
export async function ensureConsolidationCron(
  cron: CronService,
  cfg: GraftConfig,
  log: Log,
): Promise<void> {
  if (cfg.consolidationCronEnabled === false) {
    log.info(logFields({ op: "cron.consolidation", outcome: "skipped", reason: "disabled_by_config" }));
    return;
  }
  const expr = cfg.consolidationCron ?? DEFAULT_CONSOLIDATION_CRON;
  const name = CONSOLIDATION_CRON_ID;
  try {
    const existing = await cron.list({ includeDisabled: true });
    const found = existing.find((j) => j.name === name || j.id === name);
    if (found) {
      if (found.wakeMode === "now") {
        try {
          await cron.update(found.id ?? name, { wakeMode: CONSOLIDATION_WAKE_MODE });
          log.info(logFields({ op: "cron.consolidation", outcome: "updated", jobName: name, wakeMode: CONSOLIDATION_WAKE_MODE, note: "the job no longer wakes the agent; the pass runs in-process" }));
        } catch (err) {
          log.warn(logFields({ op: "cron.consolidation", outcome: "update_error", jobName: name, error: String(err) }));
        }
      } else {
        log.info(logFields({ op: "cron.consolidation", outcome: "exists", jobName: name, expr }));
      }
      return;
    }
    await cron.add({
      name,
      description:
        "xanima LLM consolidation (Engram Graft B). Staggered after memory-core dreaming (0 3 * * *). " +
        "The plugin runs the pass in-process when this job finishes (cron_changed); the job itself never wakes the agent.",
      enabled: true,
      schedule: { kind: "cron", expr },
      sessionTarget: "main",
      wakeMode: CONSOLIDATION_WAKE_MODE,
      payload: { kind: "systemEvent", text: CONSOLIDATION_EVENT_TEXT },
    });
    log.info(logFields({ op: "cron.consolidation", outcome: "registered", jobName: name, expr, wakeMode: CONSOLIDATION_WAKE_MODE }));
  } catch (err) {
    log.warn(logFields({ op: "cron.consolidation", outcome: "error", error: String(err) }));
  }
}

/**
 * Graft B: cron_changed observer → in-process consolidation pass.
 *
 * OpenClaw emits cron_changed for added / updated / removed / started / finished
 * (status ok | error | skipped). Only a completed run of our own job starts the
 * pass: the previous "looks like a fire" regex also matched `started:running`,
 * so the pass ran twice per night. A bare event (no action and no status, an
 * older host) is still treated as a fire.
 */
export function maybeRunConsolidationFromCronEvent(
  event: { action?: string; jobId?: string; jobName?: string; status?: string },
  agents: string[],
  config: ConfigSource,
  log: Log,
): void {
  const jobKey = event.jobId ?? event.jobName ?? "";
  const isConsolidation = jobKey === CONSOLIDATION_CRON_ID || jobKey.includes("openwave:consolidation");
  if (!isConsolidation) return;

  log.info(logFields({
    op: "cron_changed",
    outcome: event.status ?? event.action ?? "unknown",
    jobName: jobKey,
    status: event.status,
    action: event.action,
  }));

  const action = String(event.action ?? "").toLowerCase();
  const status = String(event.status ?? "").toLowerCase();
  const completed = action === "finished" && (status === "" || status === "ok" || status === "success");
  const bareEvent = event.action == null && event.status == null;
  if (completed || bareEvent) {
    runConsolidationPass(agents, config, log, "host_cron");
  }
}
