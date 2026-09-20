# Brain memo (openwave + sharpwave-core 0.4.2)

You have a private long-term memory graph: one brain per agent, stored at ~/.sharpwave/<your agent id>/brain.db. You do not share a brain with any other agent.

## What happens without you asking
- At session start, every turn, every heartbeat and every compaction, openwave injects memory into your context. Identity and goals arrive as a never-compacted system header. Query-relevant recall, always-on procedural rules and a last-24h activity digest arrive as prepended context. You do not need a tool call for any of this.
- If your host workspace already has a non-empty MEMORY.md or USER.md, the brain leaves out its goals block, because that host tier owns curated goals. Identity, recall and the rest still arrive.
- Your conversation turns are logged as episodes automatically.
- Background timers: awake replay every 30 min, embedding sweep every 10 min, hourly maintenance (fact extraction plus a consolidation check). Consolidation only runs when at least 4 hours have passed since the last one AND at least 10 new episodes exist.
- LLM fact extraction is on. It uses OpenRouter and only queues episodes with importance 0.4 or higher; anything else gets the simpler heuristic extractor.

## When to use the tools
- brain_query: deliberate deep recall ("what did we decide about X?"). Most turns do not need it.
- brain_write: store a durable fact on purpose. Give it a type, a short label, the content, and an importance from 0.0 to 1.0 (default 0.5).
- brain_supersede: correct or update an existing memory instead of writing a duplicate.
- brain_history: search raw conversation turns by keyword, optionally between two unix-ms timestamps.
- brain_reflect / brain_update_self_model: read or change your identity, goals and what you know about the user.
- brain_expand, brain_edges: inspect one node and its links. brain_link: connect two nodes.
- brain_review: after you recall a node, rate it 0-5 (0 blackout, 3 hard, 4 correct, 5 perfect) so its spaced-repetition schedule adapts.
- brain_stats: counts, neuromodulator state, embedding coverage.
- brain_docs: read these docs. Sections: memo, overview, schema, retrieval, consolidation, tools, v3-upgrades.

## Habits
- Search before you write, and prefer brain_supersede to a second copy of the same fact.
- Do not call brain_forget or brain_reset unless the user asks. brain_reset wipes your entire brain and only proceeds if confirm equals your exact agent id (a backup is taken first).
- Types: identity, semantic, episodic, pattern, skill, goal, emotion, procedural, schema.

## Known limits
- brain_generate_skill is not implemented in this engine version: it returns "No skill candidates ready" or a generation failure and never writes a file.
- brain_workspace only lists the shared skills folder; it does not make anything a skill. The folder is one shared setting, not per agent.
