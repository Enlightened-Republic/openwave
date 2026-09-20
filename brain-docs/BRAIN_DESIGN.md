# openwave brain design

Reference for the engine (sharpwave-core 0.4.2) as hosted by the openwave plugin. Read one section at a time with brain_docs; each call returns at most 4000 characters.

## Overview

A brain is a per-agent SQLite database (better-sqlite3 plus the sqlite-vec extension) at ~/.sharpwave/<agentId>/brain.db. It holds a graph: memory nodes, typed edges between them, raw conversation episodes, a self-model, and a small working-memory ring.

openwave adds two things the standalone MCP server cannot: automatic injection into every turn through OpenClaw's hooks, and an in-process sleep system on timers. openwave registers all 16 brain_ tools; the standalone MCP server publishes a narrower 11-tool subset. Both take their definitions from sharpwave-core's unified tool module, so the schemas cannot drift.

Per-turn injection has layers. The self-model header (identity, goals, neuromodulator state) is rebuilt every turn and is never compacted. The session-start bootstrap is queued for the first turn. Recall, procedural rules and a last-24h digest are prepended. When the host has a non-empty MEMORY.md or USER.md for the agent, the goals part of the header and bootstrap is skipped.

Timers armed at gateway start: awake replay every 30 min, embedding sweep every 10 min, hourly maintenance (LLM fact extraction harvest, then a consolidation check). The first tick runs about 5 minutes after start.

Configuration lives under plugins.entries.openwave.config: agents (required list), contextBudget (2000), workingMemorySlots (7), recallTopK (10), bootstrapTopK (15), spreadingActivationHops (1), activationThreshold (0.1), inhibitionStrength (0.6), retrievabilityFloor (0.05), pruneAfterDays (90), ingestionModel, remModel, embeddingModel, llmExtractionEnabled, llmExtractionMinImportance (0.4). Per-agent overrides of the numeric tunables go in personaOverrides.<agentId>.

## Schema

Tables: nodes, edges, episodes, self_model, working_memory, meta_kv, schema_version, node_associations, plus nodes_fts and episodes_fts (full-text) and nodes_vec (vector index).

nodes: id, type, label, content, importance, salience, stability, retrievability, ef, difficulty, access_count, emotional_weight, source, extraction_confidence, ripple_count, eligibility_trace, last_review, review_count, review_history, stability_sigma, is_consolidated, consolidated_at, valid_from, valid_until, inject_count, inject_hits, created_at, accessed_at, updated_at.

Node types: identity, semantic, episodic, pattern, skill, goal, emotion, procedural, schema.

edges: id, from_id, to_id, type, weight, valid_from, valid_until, learned_at. Edge types: caused_by, associates, supports, instance_of, goal_of, before, after, inhibits, summarizes, attaches_to, contradicts, supersedes, coreference_of, generated_skill, drives. (associated_with is a legacy read-only type; new links use associates.)

episodes: id, session_id, role, content, importance, tokens, ripple_count, llm_extracted, created_at. llm_extracted marks episodes the LLM already mined so consolidation does not process them twice.

Superseding a node (brain_supersede) closes the old node's edges and writes a supersedes edge, so the history of a fact is preserved; nodes and edges carry valid_from and valid_until for this. Embeddings are 1024-dimensional.

## Retrieval

Per-turn recall (hybridRetrieve): (1) full-text search over nodes; (2) the query is embedded (local Ollama qwen3-embedding:0.6b by default) with a 2-second budget, and if it answers, a vector search runs; (3) the two ranked lists are merged with reciprocal-rank fusion, or full-text alone if there is no embedding; (4) the top recallTopK nodes seed spreading activation, boosted by working memory; (5) activation spreads along edges for spreadingActivationHops hops, with lateral inhibition (inhibitionStrength) and an activationThreshold cutoff, modulated by neuromodulator state; (6) results are touched (access recorded) and written into working memory.

Bootstrap retrieval at session start seeds from up to 3 identity and 3 goal nodes, spreads activation from them, then fills the remaining slots with the highest-salience nodes up to bootstrapTopK.

VALOR: each node tracks inject_count and inject_hits. Utility = (hits + 1) / (count + 2) and the ranking factor is 0.5 + utility, so a node that keeps being injected but never shapes a reply drifts down, and one that is used rises. identity and goal nodes are exempt. Counts are only written when both the injection and the reply were observed.

Memory strength uses FSRS-6 spaced repetition: stability, retrievability and difficulty per node, updated by brain_review (quality 0-5). retrievabilityFloor (0.05) is the level below which a node is treated as forgotten.

## Consolidation

Awake replay (every 30 min): stabilises recently active nodes, forms Hebbian associates edges from cross-session co-activation, does prospective replay (pre-activates neighbours of active goals so the next session starts with them), and stores a dream-context snapshot for injection next session.

Full consolidation is gated: it runs only when the time since the last run is at least consolidationTimeGateHours (4) AND at least consolidationEpisodeGate (10) new episodes have arrived since. The hourly maintenance tick checks the gate. Phases: (1) SWS: extract nodes from episodes the LLM has not seen, apply a small stability downscale, promote nodes to consolidated; (1.5) NEXUS: cluster highly active nodes into schema nodes; (2) reconsolidation of recently recalled nodes; (3) REM: pattern extraction and contradiction detection, entity merging of coreferent nodes, and affective decay (emotional_weight reduced 10% on nodes not accessed for over 7 days; the content stays); (4) deep: prune near-zero-retrievability orphans.

LLM fact extraction (when llmExtractionEnabled): episodes at or above llmExtractionMinImportance are queued, harvested at session end and every hour, and written as nodes with source llm_extraction. With no API key or on failure it falls back to a heuristic extractor.

Skill evolution is not implemented in this engine version; the hooks are stubs that return nothing.

## Tools

16 tools, all prefixed brain_. Agent-facing parameters (* required):
- brain_query(query*, type, limit=10): hybrid recall, ranked with retrievability and salience.
- brain_write(type*, label*, content*, importance 0-1 default 0.5, emotional_weight -1 to 1): store a node; queued for embedding and auto-linking.
- brain_link(from_id*, to_id*, edge_type*, weight): typed edge. brain_edges(node_id*): active edges of a node.
- brain_supersede(old_node_id*, new_content*, new_label): replace a node, close its old edges, keep history.
- brain_expand(node_id*): full detail including FSRS metrics and source episodes.
- brain_review(node_id*, quality* 0-5): spaced-repetition review.
- brain_history(query*, since, until, limit=10): search raw episodes by keyword.
- brain_stats(format text|prometheus): counts, neuromodulator state, consolidation status, embedding coverage.
- brain_reflect(): read identity, goals, user model. brain_update_self_model(field* identity|goals|user_model, value*).
- brain_forget(node_id*, force): delete a node; refuses if it has active edges unless force=true.
- brain_reset(confirm*): DESTRUCTIVE wipe of this agent's brain; confirm must equal the agent id; a backup is taken first.
- brain_workspace(): lists the shared skills folder (read only). brain_docs(section*): these documents.
- brain_generate_skill(pattern_node_id): advertised, but not implemented in this version; it never writes a file.
