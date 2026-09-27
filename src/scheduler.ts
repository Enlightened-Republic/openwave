// packages/openwave/src/scheduler.ts
//
// In-process sleep-system scheduler, extracted from index.ts's `gateway_start`
// hook (Task 8). Owns the recurring timers and the extraction-harvest /
// consolidation-gate helpers they drive.
//
// In-process cadences:
//   - awake-replay tick       every 30 min  -> core.awakeReplayTick
//   - extraction harvest      every 60 min  -> harvestExtraction (bounds fact latency
//                                              for long-lived channel sessions)
//   - embedding sweep         every 10 min  -> core.sweepMissingEmbeddings + core.drainEmbeddingQueue
//
// Engram Graft B: LLM consolidation is NOT on an in-process timer any more. It
// runs from the host cron job `openwave:consolidation` (see engram-graft.ts),
// whose cron_changed event calls `runConsolidationPass` below.
//
// Every engine call goes through the `sharpwave-core` barrel. `harvestExtraction`
// is also called directly by index.ts's `session_end` hook, so it is exported.

import * as core from "sharpwave-core";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type SchedulerHandles = {
  replay: NodeJS.Timeout | null;
  /** Hourly extraction harvest (no LLM consolidation; that is host-cron driven). */
  harvest: NodeJS.Timeout | null;
  sweep: NodeJS.Timeout | null;
};

const REPLAY_INTERVAL_MS = 30 * 60 * 1000;
const HARVEST_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

// Re-entry guards so a long harvest / consolidation never overlaps the next run.
const consolidatingAgents = new Set<string>();
const harvestingAgents = new Set<string>();

// Structured logger helper (mirrors index.ts::logFields).
function logFields(fields: Record<string, string | number | boolean | undefined>): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) filtered[k] = v;
  }
  return `[openwave] ${JSON.stringify(filtered)}`;
}

// ─── Extraction harvest ────────────────────────────────────────────────────────
// Drains the LLM-extraction queue and persists results: fact nodes written,
// embeddings queued, consumed episodes flipped llm_extracted (T1.3), and
// temporal before/after edges wired. Called from the hourly harvest timer
// (bounds fact latency at ~60 min for long-lived channel sessions), from
// runConsolidationPass (before SWS, so consumed episodes are already flagged
// llm_extracted), and from index.ts's session_end hook.
export async function harvestExtraction(
  agentId: string,
  opPrefix: string,
  config: core.BrainConfig,
  log: Logger,
): Promise<void> {
  const facts = await core.drainExtractionQueue(agentId, config, log);
  for (const fact of facts) {
    const nodeId = core.writeNode(agentId, fact.type, fact.label, fact.content, {
      importance: fact.importance,
      source: "llm_extraction",
      extractionConfidence: fact.confidence,
    });
    core.queueEmbedding(agentId, nodeId);
  }

  // T1.3 dual-extraction prevention: mark consumed episodes as llm_extracted
  // so SWS skips them in consolidation.ts.
  const episodeIds = facts.episodeIds ?? [];
  if (episodeIds.length > 0) {
    try {
      const db = core.getDb(agentId);
      const mark = db.prepare("UPDATE episodes SET llm_extracted = 1 WHERE id = ?");
      db.transaction(() => {
        for (const id of episodeIds) mark.run(id);
      })();
      log.info(logFields({ agentId, op: `${opPrefix}.mark_llm_extracted`, outcome: "ok", count: episodeIds.length }));
    } catch (err) {
      log.warn(logFields({ agentId, op: `${opPrefix}.mark_llm_extracted`, outcome: "error", error: String(err) }));
    }
  }

  // Wire temporal before/after edges from LLM extraction.
  const temporalRelations = facts.temporalRelations ?? [];
  if (temporalRelations.length > 0) {
    try {
      const db = core.getDb(agentId);
      const findByLabel = db.prepare("SELECT id FROM nodes WHERE label = ? LIMIT 1");
      let wired = 0;
      for (const tr of temporalRelations) {
        const fromRow = findByLabel.get(tr.subject) as { id: string } | undefined;
        const toRow = findByLabel.get(tr.object) as { id: string } | undefined;
        if (fromRow && toRow && (tr.relation === "before" || tr.relation === "after")) {
          core.writeEdge(agentId, fromRow.id, toRow.id, tr.relation as "before" | "after");
          wired++;
        }
      }
      if (wired > 0) {
        log.info(logFields({ agentId, op: `${opPrefix}.temporal_edges`, outcome: "ok", count: wired }));
      }
    } catch (err) {
      log.warn(logFields({ agentId, op: `${opPrefix}.temporal_edges`, outcome: "error", error: String(err) }));
    }
  }

  if (facts.length > 0) {
    log.info(logFields({ agentId, op: `${opPrefix}.facts_written`, outcome: "ok", count: facts.length }));
  }
}

// ─── Hourly extraction harvest ─────────────────────────────────────────────────
// In-process, no LLM consolidation. Logs `extraction.tick` per agent.
function runHarvestTick(agentIds: string[], config: core.BrainConfig, log: Logger): void {
  for (const agentId of agentIds) {
    if (harvestingAgents.has(agentId)) {
      log.info(logFields({ agentId, op: "extraction.tick", outcome: "skipped", reason: "already_running" }));
      continue;
    }
    harvestingAgents.add(agentId);
    void harvestExtraction(agentId, "sleep_system", config, log)
      .then(() => {
        log.info(logFields({ agentId, op: "extraction.tick", outcome: "ok" }));
      })
      .catch((err) => {
        log.warn(logFields({ agentId, op: "sleep_system.extraction", outcome: "error", error: String(err) }));
      })
      .finally(() => {
        harvestingAgents.delete(agentId);
      });
  }
}

// ─── Consolidation pass (Engram Graft B: host-cron driven) ─────────────────────
// Harvest the extraction queue, then check the consolidation gate.
// shouldConsolidate() gates on the 4h time gate + 10-new-episode delta, so quiet
// agents don't consolidate and busy agents consolidate at most every
// consolidationTimeGateHours. Every pass logs `sleep_system.tick` with the
// per-agent gate verdict. Triggered by the `openwave:consolidation` host cron
// via cron_changed (engram-graft.ts::maybeRunConsolidationFromCronEvent).
export function runConsolidationPass(
  agentIds: string[],
  config: core.BrainConfig,
  log: Logger,
  trigger: string,
): void {
  for (const agentId of agentIds) {
    if (consolidatingAgents.has(agentId)) {
      log.info(logFields({ agentId, op: "sleep_system.tick", trigger, outcome: "skipped", reason: "already_running" }));
      continue;
    }
    consolidatingAgents.add(agentId);
    void (async () => {
      try {
        await harvestExtraction(agentId, "sleep_system", config, log);
      } catch (err) {
        log.warn(logFields({ agentId, op: "sleep_system.extraction", outcome: "error", error: String(err) }));
      }
      let gate = false;
      try {
        gate = core.shouldConsolidate(agentId, config);
        log.info(logFields({ agentId, op: "sleep_system.tick", trigger, outcome: "ok", consolidate: gate }));
        if (gate) {
          await core.runConsolidation(agentId, config, log);
        }
      } catch (err) {
        log.warn(logFields({ agentId, op: "consolidation.run", outcome: "error", error: String(err) }));
      }
    })().finally(() => {
      consolidatingAgents.delete(agentId);
    });
  }
}

// ─── Public surface ────────────────────────────────────────────────────────────

/**
 * Arm the three recurring in-process sleep-system timers (awake-replay,
 * extraction harvest, embedding sweep). Returns the handles so the caller (index.ts gateway_stop / lifecycle
 * cleanup) can release them for the old runtime generation.
 */
export function armSchedulers(
  agentIds: string[],
  config: core.BrainConfig,
  log: Logger,
): SchedulerHandles {
  const agents = agentIds.slice();

  // Awake-replay tick: every 30 min (matches the old cron cadence).
  const replay = setInterval(() => {
    for (const agentId of agents) {
      void core.awakeReplayTick(agentId, config, log).catch((err) => {
        log.warn(logFields({ agentId, op: "awake_replay.tick", outcome: "error", error: String(err) }));
      });
    }
  }, REPLAY_INTERVAL_MS);

  // Hourly extraction harvest. LLM consolidation is host-cron only (Graft B).
  const harvest = setInterval(() => runHarvestTick(agents, config, log), HARVEST_INTERVAL_MS);

  // In-process embedding sweep (T3.5): every 10 min, requeue orphan nodes.
  const sweep = setInterval(() => {
    for (const agentId of agents) {
      try {
        const n = core.sweepMissingEmbeddings(agentId, 50);
        if (n > 0) {
          log.info(logFields({ agentId, op: "embedding.sweep", outcome: "ok", requeued: n }));
        }
        // Drain opportunistically (returns immediately if a drain is in flight).
        void core.drainEmbeddingQueue(agentId, config, log).catch(() => {
          /* logged inside drain */
        });
      } catch (err) {
        log.warn(logFields({ agentId, op: "embedding.sweep", outcome: "error", error: String(err) }));
      }
    }
  }, SWEEP_INTERVAL_MS);

  log.info(logFields({
    op: "sleep_system",
    outcome: "ok",
    note: "in-process timers armed: awake-replay 30m, extraction harvest 60m, embedding sweep 10m; LLM consolidation via host cron openwave:consolidation",
  }));

  return { replay, harvest, sweep };
}

/**
 * Clear every timer in `handles` and reset the re-entry guard. Safe to call
 * with a null/undefined handle set (lifecycle cleanup can fire before
 * gateway_start ever armed anything).
 */
export function disarmSchedulers(handles: SchedulerHandles | null | undefined): void {
  if (handles) {
    if (handles.replay) { clearInterval(handles.replay); handles.replay = null; }
    if (handles.harvest) { clearInterval(handles.harvest); handles.harvest = null; }
    if (handles.sweep) { clearInterval(handles.sweep); handles.sweep = null; }
  }
  consolidatingAgents.clear();
  harvestingAgents.clear();
}
