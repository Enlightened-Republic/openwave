import * as core from "sharpwave-core";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type SchedulerHandles = {
  replay: NodeJS.Timeout | null;
  sweep: NodeJS.Timeout | null;
  consolidation: null;
  initialConsolidation: null;
};

const REPLAY_INTERVAL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function logFields(fields: Record<string, string | number | boolean | undefined>): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) filtered[k] = v;
  }
  return `[openwave] ${JSON.stringify(filtered)}`;
}

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

const consolidatingAgents = new Set<string>();

/** Graft B: host-cron consolidation body (no in-process hourly LLM path). */
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

export function armSchedulers(
  agentIds: string[],
  config: core.BrainConfig,
  log: Logger,
): SchedulerHandles {
  const agents = agentIds.slice();

  const replay = setInterval(() => {
    for (const agentId of agents) {
      void core.awakeReplayTick(agentId, config, log).catch((err) => {
        log.warn(logFields({ agentId, op: "awake_replay.tick", outcome: "error", error: String(err) }));
      });
    }
  }, REPLAY_INTERVAL_MS);

  const sweep = setInterval(() => {
    for (const agentId of agents) {
      try {
        const n = core.sweepMissingEmbeddings(agentId, 50);
        if (n > 0) {
          log.info(logFields({ agentId, op: "embedding.sweep", outcome: "ok", requeued: n }));
        }
        void core.drainEmbeddingQueue(agentId, config, log).catch(() => {});
      } catch (err) {
        log.warn(logFields({ agentId, op: "embedding.sweep", outcome: "error", error: String(err) }));
      }
    }
  }, SWEEP_INTERVAL_MS);

  log.info(logFields({
    op: "sleep_system",
    outcome: "ok",
    note: "in-process timers armed: awake-replay 30m, embedding sweep 10m; LLM consolidation via host cron openwave:consolidation",
  }));

  return { replay, sweep, consolidation: null, initialConsolidation: null };
}

export function disarmSchedulers(handles: SchedulerHandles | null | undefined): void {
  if (handles) {
    if (handles.replay) { clearInterval(handles.replay); handles.replay = null; }
    if (handles.sweep) { clearInterval(handles.sweep); handles.sweep = null; }
  }
  consolidatingAgents.clear();
}
