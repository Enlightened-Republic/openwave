// Engram Graft A+B helpers used by index.ts.
import { hasExternalMemoryCoreWorkspace } from "./memory-detection.js";
import { runConsolidationPass } from "./scheduler.js";

export const CONSOLIDATION_CRON_ID = "openwave:consolidation";
export const DEFAULT_CONSOLIDATION_CRON = "30 4 * * *";

type Log = { info: (m: string) => void; warn: (m: string) => void };

function logFields(fields: Record<string, string | number | boolean | undefined>): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) filtered[k] = v;
  }
  return `[openwave] ${JSON.stringify(filtered)}`;
}

export type GraftConfig = {
  agents: string[];
  curatedTierDedupe?: boolean;
  consolidationCron?: string;
  consolidationCronEnabled?: boolean;
};

export type CronService = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<Array<{ id?: string; name?: string }>>;
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
 * Graft A: detect the host curated memory tier -> sharpwave-core context opts.
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
 * VERIFIED: matches in-repo CronService.add shape. NEEDS HAILEY SMOKE: that a
 * fired job surfaces on cron_changed so runConsolidationPass runs in-process.
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
      log.info(logFields({ op: "cron.consolidation", outcome: "exists", jobName: name, expr }));
      return;
    }
    await cron.add({
      name,
      description:
        "openwave LLM consolidation (Engram Graft B). Staggered after memory-core dreaming (0 3 * * *). " +
        "Firing should surface on cron_changed so openwave runs runConsolidationPass in-process.",
      enabled: true,
      schedule: { kind: "cron", expr },
      sessionTarget: "main",
      wakeMode: "now",
      payload: {
        kind: "systemEvent",
        text: "[openwave:consolidation] Sleep-system consolidation window — openwave handles this in-process via cron_changed.",
      },
    });
    log.info(logFields({ op: "cron.consolidation", outcome: "registered", jobName: name, expr }));
  } catch (err) {
    log.warn(logFields({ op: "cron.consolidation", outcome: "error", error: String(err) }));
  }
}

/** Graft B: cron_changed observer → in-process consolidation pass. */
export function maybeRunConsolidationFromCronEvent(
  event: { action?: string; jobId?: string; jobName?: string; status?: string },
  agents: string[],
  config: Parameters<typeof runConsolidationPass>[1],
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

  const action = `${event.action ?? ""}:${event.status ?? ""}`.toLowerCase();
  const looksLikeFire =
    /fire|run|start|exec|trigger|succeed|ok/.test(action) &&
    !/remove|delete|update|add|create|disable/.test(action);
  if (looksLikeFire || (event.action == null && event.status == null)) {
    runConsolidationPass(agents, config, log, "host_cron");
  }
}
