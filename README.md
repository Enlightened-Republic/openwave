# Xanima for OpenClaw (`xanima-openclaw`, formerly openwave)

**Autonomic long-term memory and agent continuity for [OpenClaw](https://openclaw.ai) agents.**

Xanima hooks OpenClaw's turn lifecycle. On every session start, every turn,
every heartbeat, and every compaction it pulls the memories relevant to what the
agent is about to do out of that agent's brain and **injects them into context
automatically — no tool call**. Identity and goals ride in as a never-compacted
system header; query-relevant recall (with confidence and relative-time labels),
always-on procedural rules, and a last-24h activity digest ride in as prepended
context. The agent wakes up already knowing.

It also runs the sleep system in-process on timers — slow-wave/REM consolidation,
awake replay, and LLM fact extraction — so the graph keeps improving between
sessions without anything calling it. On top of memory it keeps the agent
*continuous*: a decision ledger, versioned goals with drift detection,
reflection and experience replay, commitments and plans, a portable Soul
Package, shared rooms, and an identity the agent can evolve under guardrails.

The engine is [`xanima-core`](https://www.npmjs.com/package/xanima-core)
(formerly sharpwave-core), the same memory engine behind the
[`xanima`](https://www.npmjs.com/package/xanima) MCP server (formerly
`sharpwave`). **Use the `xanima` MCP server for Claude Code / Cursor / Claude
Desktop. Use this plugin for OpenClaw** — it does everything the MCP server
does, plus the automatic per-turn injection and the in-process sleep system that
an MCP server structurally cannot.

| | |
|---|---|
| npm package | [`xanima-openclaw`](https://www.npmjs.com/package/xanima-openclaw) 0.6.0 |
| ClawHub | `clawhub:xanima` |
| plugin id | `xanima` (manifest `legacyPluginIds: ["openwave"]`) |
| config entry | `plugins.entries.xanima` |
| engine | `xanima-core` 0.6.0, schema v27 |
| brain files | `~/.xanima/<agentId>/brain.db` |
| tools | 43 `brain_*` tools (names unchanged since openwave and permanent) |
| brain service | `xanima-server` (formerly sharpwave-server; see [Remote brain mode](#remote-brain-mode)) |

---

## Install

### From ClawHub (recommended)

```bash
openclaw plugins install clawhub:xanima --accept-capabilities
```

Published by `@EnlightenedRepublic`, source-linked to this repo. If `db.init`
fails with "Could not locate the bindings file" after install, run the native
rebuild step shown under **From npm** below (in the plugin's install directory).

### From npm

```bash
openclaw plugins install npm:xanima-openclaw --force --accept-capabilities
cd ~/.openclaw/npm/projects/xanima-openclaw && npm rebuild better-sqlite3
```

`--force` acknowledges an npm (non-ClawHub) source. The `npm rebuild` step is
**required** — OpenClaw's plugin installer runs `npm install --ignore-scripts`,
so `better-sqlite3`'s native binary is not fetched/built during install. Without
it, every `db.init` fails with "Could not locate the bindings file". Run it in
whatever directory OpenClaw installed the package to, and re-run it after any
`openclaw plugins update xanima`.

### From source (development)

```bash
git clone https://github.com/Enlightened-Republic/xanima-openclaw
cd xanima-openclaw && npm ci && npm run build
```

Then point `plugins.load.paths` at the checkout directory (not `dist/index.js` —
OpenClaw reads `openclaw.plugin.json` next to it):

```jsonc
"plugins": {
  "load": { "paths": ["/abs/path/to/xanima-openclaw"] }
}
```

### Configure (all install methods)

Add the entry to `openclaw.json`:

```jsonc
"plugins": {
  // If plugins.allow is set (it's an exclusive allowlist), xanima MUST be in it.
  "allow": ["...your other plugin ids...", "xanima"],
  "entries": {
    "xanima": {
      "enabled": true,
      "hooks": { "allowConversationAccess": true },
      "config": { "agents": ["main"] }
    }
  }
}
```

Then restart the gateway (`openclaw gateway restart` — a full restart, not a soft
reload) and confirm from the log:

```
[xanima] {"op":"config.source","outcome":"xanima"}
[xanima] {"op":"register","outcome":"ok","agents":<N>,"tools":43,"engine":"xanima-core",...}
[xanima] {"op":"gateway_start","outcome":"ready",...}
```

**`hooks.allowConversationAccess: true` is required** — xanima is a non-bundled
plugin and its `before_prompt_build` / `agent_turn_prepare` / `llm_output` /
`agent_end` hooks read conversation content.

**`config.agents` is required and has no safe default on a multi-agent gateway.**
Every hook and tool call guards on the served-agent list; an agent not listed
gets no injection, no episode logging, no sleep system. List every agent you
want xanima to serve, or use `"agents": "*"` (see
[Automatic agents](#automatic-agents-and-provisioning-remote-mode)).

**Compatibility:** `pluginApi >= 2026.5.0`, `minGatewayVersion 2026.5.0`. Older
gateways don't expose the hook and session-workflow surface xanima needs.

---

## Upgrading from openwave

openwave 0.2.x installs keep working: the plugin id `xanima` carries
`legacyPluginIds: ["openwave"]`, and when `plugins.entries.xanima` has no
settings of its own the plugin reads `plugins.entries.openwave.config` and logs
a one-time `[xanima] DEPRECATED` warning. Move over once, then the warnings stop:

```bash
xanima-openclaw-upgrade --config ~/.openclaw/openclaw.json          # dry run: prints what would change
xanima-openclaw-upgrade --config ~/.openclaw/openclaw.json --write  # timestamped backup first, then writes
```

The upgrade **copies** the openwave block to `plugins.entries.xanima`, disables
(does not delete) `plugins.entries.openwave` so the two never both register the
`brain_*` tools, and adds `"xanima"` next to `"openwave"` in `plugins.allow` /
`plugins.deny`. It never overwrites an `entries.xanima` block that already has
settings. `--config` defaults to `$OPENCLAW_CONFIG_PATH`, then
`$OPENCLAW_STATE_DIR/openclaw.json`, then `~/.openclaw/openclaw.json`. The file
must be plain JSON (no comments); otherwise copy the block by hand.

What else changed:

- **Brain files** live in `~/.xanima/<agentId>/brain.db`. While `~/.xanima` does
  not exist and `~/.sharpwave` does, the old folder is used (with a one-time
  notice). `xanima-server migrate` copies it over; the old folder is never moved
  or deleted. After migrating, `xanima-openclaw-upgrade --data-paths --write`
  repoints `.sharpwave` paths in your config (`brainTokenFile`,
  `provisionTokenFile`, …) at `.xanima`, but only for targets that exist there.
- **Env vars**: `$XANIMA_BRAIN_TOKEN` replaces `$OPENWAVE_BRAIN_TOKEN`; the
  engine's `XANIMA_DATA_DIR` / `XANIMA_DB_PATH` / `XANIMA_EMBEDDING_MODEL` /
  `XANIMA_OPENROUTER_API_KEY` replace the `SHARPWAVE_` names. The old names are
  still read in 0.5.0 with a deprecation warning and will be dropped in a later
  release.
- **Tool names** (`brain_*`) are unchanged and permanent. The host cron id stays
  `openwave:consolidation` (renaming it is deferred).
- **Rollback**: re-enable `plugins.entries.openwave`, disable `entries.xanima`
  (or restore the `openclaw.json.pre-xanima-*.bak` the upgrade wrote), restart.

---

## Configuration

xanima's config is `xanima-core`'s `BrainConfig` plus the host-only fields
below. Everything under `plugins.entries.xanima.config` is merged over the
manifest defaults and passed straight into the engine.

| field | type | default | meaning |
|---|---|---|---|
| `agents` | `string[]` \| `"*"` | `["main"]` | **Required.** OpenClaw agent ids xanima serves (`"*"` = every agent in the OpenClaw config). Local mode routes each to `~/.xanima/<id>/brain.db`. |
| `excludeAgents` | `string[]` | `[]` | Agent ids never served (applies to `"*"` and explicit lists). |
| `enabled` | `boolean` | `true` | `false` (or `entries.xanima.enabled: false`) → `register` returns immediately, no tools, no hooks. |
| `llmExtractionEnabled` | `boolean` | `false` | `true` → `message_received` / `llm_output` episodes at or above `llmExtractionMinImportance` are queued for LLM fact extraction into graph nodes. `false` → heuristic extractor only. |
| `llmExtractionMinImportance` | `number` | `0.4` | Importance floor for queueing an episode for extraction. |
| `skipSystemTurns` | `boolean` | `true` | Skip OpenClaw system turns on every memory-writing path (local and remote): heartbeat polls and their replies, `[OpenClaw exec completion]` / cron / session-event wakes, `NO_REPLY` / `HEARTBEAT_OK` replies, memory-flush runs. Skipped turns get **no episode and no extraction**. See [System turns](#system-turns). |
| `systemTurnPatterns` | `string[]` | `[]` | Extra case-insensitive regexes; a turn whose trimmed text matches is skipped like a system turn. Invalid entries are ignored (warned once). |
| `ingestionModel` | `string` | `"openrouter/deepseek/deepseek-v4-flash"` | Model for LLM fact extraction and generative REM. `openrouter/provider/model` or bare `provider/model` both work. |
| `openRouterApiKey` | `string` | `$OPENROUTER_API_KEY` / `$XANIMA_OPENROUTER_API_KEY` / `""` | OpenRouter key for engine LLM calls. Empty → extraction and generative-REM degrade to heuristic mode (non-fatal). Prefer the env var over putting the key in `openclaw.json`. |
| `consolidationCron` | `string` | `"30 4 * * *"` | Host cron expression for the `openwave:consolidation` job (LLM consolidation), staggered after memory-core dreaming. The job never wakes the agent; see [Sleep system](#sleep-system-and-the-consolidation-cron). |
| `consolidationCronEnabled` | `boolean` | `true` | Register the consolidation host cron on `gateway_start` (the in-process timers run either way). |
| `curatedTierDedupe` | `boolean` | `true` | When `MEMORY.md` / `USER.md` is present, tell the engine so durable identity/goals are not double-injected. |
| `personaOverrides` | `object` | `{}` | Per-agent-id overrides of the numeric tunables below, keyed by OpenClaw agent id; written by the Control UI page and applied on every local-mode engine call. Missing keys inherit the flat value. See [Persona overrides](#persona-overrides-control-ui). |
| `allowAgentReset` | `boolean` | `false` | Let the agent call `brain_reset` on its own brain. Off by default: the engine's only guard is `confirm` = the agent's own id, which it knows, so a prompt injection could wipe the brain. Local and remote. |

Engine (`BrainConfig`) fields you can also override, passed through to
`xanima-core` (defaults from `core.DEFAULT_CONFIG`):

| field | type | default | meaning |
|---|---|---|---|
| `contextBudget` | `number` | `2000` | Token budget the context assembler targets for injected recall. |
| `workingMemorySlots` | `number` | `7` | Working-memory ring size. |
| `spreadingActivationHops` | `number` | `1` | Spreading-activation hop count during recall. |
| `activationThreshold` | `number` | `0.1` | Minimum activation for a node to be recalled. |
| `inhibitionStrength` | `number` | `0.6` | Lateral-inhibition strength in activation. |
| `recallTopK` | `number` | `10` | Max nodes in a per-turn recall block. |
| `bootstrapTopK` | `number` | `15` | Max nodes in the session-start bootstrap. |
| `efDefault` | `number` | `2.5` | Starting FSRS ease factor for new nodes. |
| `retrievabilityFloor` | `number` | `0.05` | Retrievability below which a node is treated as forgotten. |
| `consolidationTimeGateHours` | `number` | `4` | Hours since last consolidation before the gate opens. |
| `consolidationEpisodeGate` | `number` | `10` | New-episode count before the consolidation gate opens. |
| `pruneAfterDays` | `number` | `90` | Age after which low-value nodes are pruned. |
| `remModel` | `string?` | _(unset)_ | REM-consolidation model override; falls through to `ingestionModel`. |
| `embeddingModel` | `string` | `$XANIMA_EMBEDDING_MODEL` / `"ollama/qwen3-embedding:0.6b"` | Embedding model (1024-dim). |
| `skillEvolution` | `boolean` | `false` | Enable pattern→skill generation. |
| `skillEvolveMinPatternCount` | `number` | `5` | Pattern occurrences before a skill is generated. |
| `workspaceSkillsDir` | `string` | `""` | Output dir for `brain_generate_skill` / `brain_workspace`. |
| `brainDocsDir` | `string` | `""` | Docs corpus dir for `brain_docs`. |

Env vars the engine reads directly: `OPENROUTER_API_KEY` /
`XANIMA_OPENROUTER_API_KEY`, `XANIMA_EMBEDDING_MODEL`, `XANIMA_DATA_DIR`
(brain-db parent dir) / `XANIMA_DB_PATH` (exact file), `OLLAMA_BASE_URL`. The
`SHARPWAVE_*` spellings still work with a deprecation warning.

### Continuity settings

Each release since the rename added switches; all have working defaults and
live in the same `config` block (in remote mode the engine-side ones are read
from the service's `config.json` `brain` block instead).

- **Beliefs (0.1.0):** `beliefMetadata`, `relativeTimeLabels`, `selfStatus`,
  `lowConfidenceThreshold` (0.4), `sleepBeliefReview` — all on by default.
- **Decisions and goals (0.2.0):** `decisionLedger`, `decisionAutoExtract`,
  `decisionLessonPromotion`, `decisionBoost`, `intentDriftCheck` (`sleep` |
  `daily` | `off`), `driftDays`, `goalTriggers`, `soulHeader`,
  `alignmentNoteMaxTokens`, `decisionDraftTtlDays`, `lessonMergeSimilarity`.
- **Reflection and open items (0.3.0):** `reflection` (`off` | `sleep`),
  `reflectionLlm`, `reflectionWindowDays`, `openItemCapture`,
  `openItemDraftTtlDays`, `openItemSurfacing`, `commitmentNudges`,
  `replayMaxChars`, `metaToolMaxChars`.
- **Rooms, focus, quarantine (0.5.0):** `quarantine` (`log` | `enforce`),
  `injectionCategories`, `focusDefaultTtl`.
- **Identity (0.5.0):** `identity` (`changesFrom`, `selfEdit`, `refuseUntrusted`,
  `saveRefusedAsNote`, `locked`, `maxChangesPerDay`, `maxChars`,
  `requireAttestation`), `identityMirror`, `identityTrustedTools`.
- **Memory for life (unreleased):** `forgetting` (`dormant` | `delete`, default
  `dormant`: faded memories stay on disk and come back on an explicit search),
  `procedures` (true) and `procedureVerifyAfter` (2): plans the agent carried
  out become step-by-step procedures, verified by repeated success.
- **Soul Package (0.4.0):** `soulExportProfile` (`compact` | `full`),
  `soulTokenBudget`, `soulMinFactConfidence`, `soulImportConfidence`,
  `soulMergeApplyTheirs`, `soulPackageOnExport`.
- **Rooms (0.5.0):** `rooms`, `roomRecallMax`.

The behaviour behind each group is described under [Tools](#tools).

### Persona overrides (Control UI)

The plugin registers a Control UI page ("Xanima", shown once Settings → Labs →
Custom plugin UI is on) and four session actions (`getPersonaConfig`,
`setPersonaOverride`, `clearPersonaOverride`, `getBrainConnection`). The page
writes `plugins.entries.xanima.config.personaOverrides.<agentId>` through the
host's config mutation API. The numeric fields (`contextBudget`,
`workingMemorySlots`, `spreadingActivationHops`, `activationThreshold`,
`inhibitionStrength`, `efDefault`, `retrievabilityFloor`,
`consolidationTimeGateHours`, `consolidationEpisodeGate`, `pruneAfterDays`)
are laid over the flat config for that agent on every local-mode engine call:
hooks, tools and the sleep timers. `emotionalProfile` is accepted and stored
but has no engine field yet. In remote mode the engine runs on the brain
service, so persona overrides have no effect there.

### System turns

OpenClaw runs heartbeat polls, exec-completion / cron / session-event wakes and
memory-flush runs as agent turns. Their text is machinery ("[OpenClaw heartbeat
poll]", "NO_REPLY — nothing urgent…"), and stored as episodes it was being
consolidated into recallable nodes that outranked real memories. One classifier
(`src/system-noise.ts`, `isSystemNoiseTurn`) gates every path that writes
memory — episode append (local `appendEpisode`, remote `brain_episode_append`),
the LLM-extraction queue (drained by the hourly and `session_end` harvest, local
and remote), and therefore heuristic SWS, which only reads the episode log.

Signals, strongest first (OpenClaw 2026.9.x):

1. **Structured** — agent-hook `ctx.trigger` `heartbeat` or `memory`;
   `ctx.inputProvenance.kind === "internal_system"` (any `sourceTool` except
   `cron`); isolated heartbeat session keys ending in `:heartbeat`.
2. **Text fallback** — user turns starting with an internal wake marker
   (`[OpenClaw heartbeat poll]`, `[OpenClaw exec completion]`, `[OpenClaw cron
   wake]`, `[OpenClaw session event]`), the default/legacy heartbeat prompt,
   exec/cron event prompts, or bodies made only of `System:` event lines;
   assistant replies that are, or start with, `NO_REPLY` / `HEARTBEAT_OK`
   (also JSON envelopes, reasoning-prefixed, and short trailing acks).
3. **Pairing** — after a skipped user turn, the next reply in that session is
   skipped too.

Skipped turns are **not appended at all** (no tag): the brain service's sleep
selects episodes by importance only, so a tagged episode would still be
consolidated unless every consumer learned the tag. Isolated automation (`cron`)
turns are not skipped; they keep the existing importance clamp (0.1, below
extraction). Normal turns that merely mention heartbeats are kept.

---

## Sleep system and the consolidation cron

Local mode runs three in-process timers, armed on `gateway_start` and released
on `gateway_stop` and on every lifecycle cleanup: awake replay every 30 min,
extraction harvest every 60 min, embedding sweep every 10 min. If a lifecycle
`restart` cleanup released them and no `gateway_start` followed (a plugin
generation sharing this module instance), the next turn re-arms them and logs
`{"op":"sleep_system","outcome":"rearmed"}`.

LLM consolidation runs from the host cron job `openwave:consolidation`
(`consolidationCron`, default 04:30, staggered after memory-core dreaming at
03:00). The job is a main-session `systemEvent` with `wakeMode:
"next-heartbeat"`: it **never starts an agent turn**; it only ticks
`cron_changed`, and the plugin runs the pass in-process when that event says
the job **finished** with status **ok**. A job left behind by an older version
with `wakeMode: "now"` (which made OpenClaw wake the agent every night) is
switched in place on the next `gateway_start`.

What to look for in the gateway log:

```
[xanima] {"op":"cron.consolidation","outcome":"registered"|"exists"|"updated",...}
[xanima] {"op":"cron_changed","jobName":"openwave:consolidation","action":"finished","status":"ok",...}
[xanima] {"op":"sleep_system.tick","trigger":"host_cron","outcome":"ok","consolidate":true|false,...}
[xanima] {"op":"extraction.tick","outcome":"ok",...}        every hour
```

`consolidate` is `false` while the gate is closed (fewer than
`consolidationEpisodeGate` new episodes or less than
`consolidationTimeGateHours` since the last pass). Remote mode registers no
cron and no timers: the brain service owns sleep.

Two things sleep does with this engine that it did not before. **Forgetting is
dormancy, not deletion** (`forgetting: "dormant"`, default): a memory whose
retrievability has decayed to nothing is marked dormant and leaves recall and
the header, but stays on disk with its links and vector; `brain_query
{include_dormant: true}` finds it again and revives it, `brain_status` counts
them, and `forgetting: "delete"` restores the old physical prune. **Learning
becomes a step-by-step skill** (`procedures`, default on): a plan the agent
carried out (`brain_plan … done`, at least two done steps) is compiled into a
`procedural` node with numbered steps and a success / failure ledger; after
`procedureVerifyAfter` (2) successful runs it is verified and injected as an
operational rule, and a matching abandoned plan counts against it. Only
verified procedures (and hand-written rules) reach the "operational rules"
block; a sentence sleep merely extracted from a pasted page never does.

---

## Remote brain mode

By default xanima opens `~/.xanima/<agent>/brain.db` in-process (`brainMode: "local"`).
With `brainMode: "remote"` it instead talks to the **Xanima brain service**
(`xanima-server`, formerly sharpwave-server) over MCP Streamable HTTP, using a
per-agent bearer token. The service owns storage *and* sleep, and one service
can serve several agents, a shared brain, and rooms.

`xanima-server` is a private workspace package (not on npm). Build it from a
checkout of the [xanima](https://github.com/Enlightened-Republic/xanima) repo
(formerly sharpwave; `npm ci && npm run build --workspace xanima-server`) and
run `node packages/server/dist/cli.js serve`; it listens on `127.0.0.1:18790`.

```jsonc
"plugins": {
  "entries": {
    "xanima": {
      "enabled": true,
      "hooks": { "allowConversationAccess": true },
      "config": {
        "agents": ["main"],
        "brainMode": "remote",
        "brainUrl": "http://127.0.0.1:18790",
        "brainTokenFile": "~/.xanima/tokens/{agentId}.token",
        "sharedRecall": true,
        "remoteTimeoutMs": 2500
      }
    }
  }
}
```

| field | default | meaning |
|---|---|---|
| `brainMode` | `"local"` | `"remote"` switches to the brain service. Local installs are unaffected. |
| `brainUrl` | `http://127.0.0.1:18790` | Service base URL (`/mcp`, `/health`). |
| `brainTokenFile` | — | **Preferred.** File holding the token from `xanima-server token mint --agent <id>`. `~` and `{agentId}` (the OpenClaw agent id) are expanded, so one entry serves several agents. UTF-8/UTF-16/BOM all accepted. |
| `$XANIMA_BRAIN_TOKEN` | — | Used when `brainTokenFile` is unset (single agent only). `$OPENWAVE_BRAIN_TOKEN` is still read, with a warning. |
| `brainToken` | — | Inline token (discouraged: it lands in `openclaw.json`). Single agent only. |
| `sharedRecall` | `true` | Per-turn recall also searches the shared brain; shared hits are tagged `[type·shared]`. |
| `remoteTimeoutMs` | `2500` | Per-call budget, and the budget for the per-turn hook as a whole: recall, the goals block and the status footer are requested in parallel. A slow/dead service costs a turn at most this, then the client backs off (2s → 60s) and fails fast. |

The token is never logged; only its source (`file`/`env`/`inline`) is. A rejected
token logs an `error` line containing `BAD BRAIN TOKEN` and the `getBrainConnection`
settings action reports `status: "unauthorized"`.

**What works remotely:** 39 of the 43 tools, proxied 1:1 to the service (all of
the memory, belief, decision, goal, reflection, open-item, commitment, plan,
meta, soul-export, room, focus and identity tools; the continuity tools always
use the agent's private brain on the service); per-turn recall (private + shared
+ subscribed rooms) in the same `[BRAIN: on your mind …]` block with Graft A
dedupe (identity/goal hits dropped when `MEMORY.md` / `USER.md` is curated); a
`[BRAIN: goals]` block fed by the service's `brain_turn_context`; episode writes
via `brain_episode_append` (feature-detected from the service's tool list; every
`xanima-server` release advertises it); LLM-extraction facts written to the
service on `session_end` and hourly (a batch interrupted by an outage waits in
memory for the next harvest); the memory-corpus supplement.

**Disabled in remote mode** (no service equivalent yet): the local brain.db,
in-process sleep timers (awake replay, hourly harvest-to-local, embedding
sweep), the `openwave:consolidation` host cron (an existing one is removed),
the session bootstrap block, identity/goals/neuro header lines (a one-line
`[Xanima remote]` banner is injected instead), the procedural-rules block, the
last-24h activity block, proactive monitor / working memory / coactivations /
dopamine, VALOR scoring, subconscious tick, compaction graph handling (only the
compaction marker episode is appended), temporal edges from extraction, persona
overrides (the engine runs on the service), and the four local-only tools
`brain_update_self_model`, `brain_generate_skill`, `brain_workspace`,
`brain_docs`.

### Automatic agents and provisioning (remote mode)

```json5
{
  agents: "*",                    // every agent in OpenClaw's config (or autoAgents: true)
  excludeAgents: ["scratch"],     // never served
  brainMode: "remote",
  brainTokenFile: "~/.xanima/tokens/{agentId}.token",   // must contain {agentId}
  autoProvision: true,
  provisionTokenFile: "~/.xanima/tokens/_provisioner.token",
  rosterPollMs: 30000,
}
```

- The agent set is read from OpenClaw's **live** config (`api.runtime.config.current()`, `agents.entries` or
  `agents.list`) on each turn, at `gateway_start`, and every `rosterPollMs`. An agent added with `openclaw agents add`
  is served on its first turn, with **no gateway restart**.
- With `autoProvision`, an agent that has no token file triggers `brain_provision_agent` on `xanima-server`. The
  server creates the agent's brain and mints a token with its own configured scopes (default `read,write,shared-write`,
  never admin). Xanima writes the token file atomically (POSIX `0600`; on Windows the temp file is locked with `icacls` to
  the current user + SYSTEM before it is renamed into place, and nothing is written if that fails) and connects right away.
- `provisionTokenFile` should hold a token minted with **only** the `provision` scope
  (`xanima-server token mint --agent xanima-provisioner --scopes provision`). That scope can't read or write any
  brain, and the server accepts it only on 127.0.0.1.
- Idempotent: agents with a token file are never re-provisioned. If the service already has a token for an agent whose
  file is missing, xanima logs `token_file_missing` and doesn't mint a second one.
- Service down: the turn proceeds without memory, and provisioning retries per agent with backoff (2 s up to 5 min).
  Tokens are never logged.
- An explicit `agents: [...]` list behaves exactly as before.

---

## Tools

xanima registers all **43** `brain_*` tools. Definitions and executors come
from `xanima-core`'s unified tool module, so this plugin and the `xanima` MCP
server can never expose a drifted schema.

| group | tools |
|---|---|
| memory | `brain_query`, `brain_write`, `brain_link`, `brain_supersede`, `brain_stats`, `brain_history`, `brain_expand`, `brain_review`, `brain_forget`, `brain_edges`, `brain_reset`, `brain_update_self_model`, `brain_generate_skill`, `brain_workspace`, `brain_docs` |
| beliefs (0.1.0) | `brain_retract`, `brain_status` |
| decisions and goals (0.2.0) | `brain_record_decision`, `brain_update_decision_outcome`, `brain_query_decisions`, `brain_set_goal`, `brain_update_goal`, `brain_list_goals` |
| reflection, open items, plans (0.3.0) | `brain_reflect`, `brain_replay`, `brain_hypothesis`, `brain_question`, `brain_list_open`, `brain_commit`, `brain_commitments`, `brain_plan`, `brain_changes`, `brain_conflicts`, `brain_briefing`, `brain_forget_impact` |
| soul (0.4.0) | `brain_export_soul` |
| rooms, focus, identity (0.5.0) | `brain_room`, `brain_publish`, `brain_unpublish`, `brain_room_query`, `brain_subscribe`, `brain_focus`, `brain_identity` |

**Result shape.** Every `brain_*` tool (local and remote mode) returns
`{ content: [{ type: "text", text }], details: { text, error?, data? } }` and
declares that `details` shape as its `outputSchema`. `details.text` is the same
text as the content block; `error` is set (same text) only on a failed call;
`data` is the parsed JSON when the output is JSON (e.g. `brain_query` with
`format: "json"`). This matters because OpenClaw's Code Mode (on by default via
`tools.codeMode: "auto"` for preferred models) and Tool Search value calls hand
the model **only** `details`.

Most memory work needs **no** tool call — xanima injects and logs
automatically. The tools are for deliberate deep recall (`brain_query`, with
`as_of` for "what did I believe about X on date T" and `include_dormant: true`
to search memories sleep made dormant and revive what matches), reading the
original conversation behind a memory (`brain_expand` with `source_turns: N`:
the source turn marked `»` with N turns either side), deliberate writes
(`brain_write`), corrections with a reason (`brain_retract`, `brain_supersede`),
and introspection (`brain_status`).

**Beliefs.** Every memory carries a confidence (low/medium/high/certain + a
score), a source (`user`, `self_observation`, `inference`, `tool`, `agent`,
`seed`, `legacy`), a status and a sensitivity. Recall lines say when a memory
was learned ("3 days ago") and mark low confidence with `(?)` and disputed
beliefs as `disputed`.

**Decisions and goals.** The agent's own "I'll go with X over Y because …"
becomes a low-confidence decision draft. Each turn may get one small
`[BRAIN: goals]` block: an alignment note after the drift pass found a stalled or
conflicting goal (acked after the first real reply; memory-tool-only turns do
not use it up), and goal lines whose keyword / time trigger fired. Matching
decisions get a light recall boost. Goals are versioned with history.

**Reflection, open items, plans.** The agent's own "I think … because …", "open
question: …" and "I'm assuming …" become drafts (`brain_hypothesis`,
`brain_question`, `brain_list_open`). The `[BRAIN: goals]` block may also carry
one overdue-commitment nudge and one relevant open question. `brain_plan` parks
and resumes work with a briefing; `brain_briefing`, `brain_changes` and
`brain_conflicts` are the meta-tools for "what changed / what disagrees".

**`brain_reset` is refused unless `allowAgentReset: true`.** With it on, an
agent can wipe its own brain by calling the tool with `confirm` set to exactly
its own agent id; a timestamped `.db` backup is taken first, and the wipe is
`DELETE FROM` on learned-state tables plus a re-seed of an empty self-model —
never `DROP` — so embedding config and vector-table dimension are preserved.
It is off by default because the agent knows its own id, so that guard alone
does not stop a prompt injection. The tool stays registered and answers with a
clear refusal (local and remote); operators reset with the `xanima-server` CLI
or the `xanima` MCP server.

**Soul Package (0.4.0).** `brain_export_soul` exports the agent's **own** brain as a
portable `xanima-soul/1` package (identity, values, goals with history, top skills,
decision lessons, key facts, provenance, sha256): a summary by default, or compact
JSON with `format: "json"`. Sensitive items and the shared brain are never exported
through the tool. `brain_review` also has a queue mode (`action: "list" | "show"`)
showing identity / value / goal changes that arrived through an import or a merge
and wait for a human; `accept` / `reject` need an admin (in remote mode, an admin
token on the service). Import, fork and merge are operator steps on the brain host:
`xanima-server soul import | fork | diff | merge | review` (see
`docs/portability.md` in the xanima repo). In remote mode the plugin proxies `brain_export_soul` and
`brain_review`; `brain_import_soul` is never offered to the agent.

**Rooms, focus and quarantine (0.5.0).** In remote mode the plugin proxies the room
tools of `xanima-server` 0.5.0: `brain_room` (list / members / conflicts; create
with a `room-admin` token; invite / revoke for room admins), `brain_publish`,
`brain_unpublish`, `brain_room_query` and `brain_subscribe`. The per-turn recall
asks the service with `inject: true`, so up to `roomRecallMax` items from subscribed
rooms show up tagged `[type·room·writer]`, and the service applies `brain_focus`,
`injectionCategories` and the sensitivity labels. In local mode the room tools
answer that rooms need the brain service. `brain_focus {suppress: ["project:x" |
"room:team" | "type:decision" | "topic"], ttl: 2 | "task"}` works in both modes
and only ever shapes recall; the identity, goals and rules header is untouched.
Sensitive memories are injected only when the turn names their topic, and
`confirm_before_acting` ones keep their marker. Settings: `quarantine` (`log` by
default: identity / goal / rule writes from tool output, other agents, imports or
injection-looking text: goal writes are recorded and still applied, identity /
value writes are held; `enforce` holds them all in `brain_review`),
`injectionCategories`, `focusDefaultTtl`. In remote mode the service's own
settings apply. See `docs/rooms.md` and `docs/security-model.md` in the xanima repo.

**Agents evolve their own identity (`brain_identity`).** The agent can add, change or
remove a line of its identity header (`- **Field:** value`) or a core value, with a short
reason: `brain_identity {action: "change", target: "field", field: "Vibe", value: "…",
reason: "…"}` (`get` / `history` to read). **Who the agent is changes only through
conversations with its owner.** A change proposed in a conversation the plugin attests as
the owner's applies at once, is versioned and shows in the header from the next turn. A
change the agent proposes in its own reflection run (cron / heartbeat) is **held**: a
pending review item the owner accepts or rejects from the conversation with
`brain_review {action: "accept" | "reject", id}` (in local mode the owner in the
conversation is the admin; a cron run or a run that read tool output cannot accept). The
operator sees applied changes in `brain_status` and `xanima-server identity history
--agent X`, and can undo one with `identity revert <version>`. In a run where a non-memory
tool (web, read, exec, …) returned output, the run came from a non-owner sender (with
`commands.ownerAllowFrom` set), or the new text repeats recent tool output, the change is
**refused**, with a pointer to save what was learned with `brain_write` as knowledge or a
skill; the proposal is kept as a candidate knowledge note tagged `source:web`,
quarantine-checked. Whatever the model claims about provenance is ignored.

Who the owner is: with `commands.ownerAllowFrom` configured the plugin attests owner turns
and the engine default `identity.changesFrom: ["owner_turn"]` applies, so a change proposed
in any other turn is held. Without an owner list the plugin cannot tell the one human on the
box from anyone else, so a clean conversational turn counts as the owner's
(`changesFrom: ["owner_turn", "agent_turn"]`), as in 0.5.0; reflection runs are still held.
Set `identity.changesFrom` yourself to override either way (add `reflection` for the 0.5.0
self-evolution). In remote mode the brain service's own `identity` config decides, and the
owner accepts held proposals with an admin token or `xanima-server soul review accept`.
Sleep never changes identity either: an "I value …" / "I prefer …" sentence in the owner's
turns is stored as a fact about the owner, never as the agent's value. Switches under
`identity`: `changesFrom`, `selfEdit` (true), `refuseUntrusted` (true), `saveRefusedAsNote`
(true), `locked` (`["Name"]`), `maxChangesPerDay` (0 = no limit), `maxChars` (2000),
`requireAttestation` (false). Plugin settings: `identityMirror` (false; when true, applied
changes are written back to the workspace `IDENTITY.md` field lines and a managed "Evolved
values" block in `SOUL.md`) and `identityTrustedTools` ([]; tools whose output doesn't count
as outside content).

---

## Brain databases

Brain dbs live at `~/.xanima/<agentId>/brain.db` (plus SQLite `-wal` / `-shm`
sidecars). Redirect with `XANIMA_DATA_DIR` (parent dir) or `XANIMA_DB_PATH`
(exact file). An un-migrated install still reads `~/.sharpwave` until
`xanima-server migrate` copies it (see [Upgrading](#upgrading-from-openwave)).

xanima and the `xanima` MCP server read and write the **same files** with the
**same engine code**, so an agent can be moved between them with no data
migration. First open runs the additive-only schema migration to **v25** — no
data loss.

---

## Rollback (to the xanima MCP server)

1. `openclaw plugins disable xanima` (or `entries.xanima.enabled: false`).
2. Add the `xanima` MCP server entry (`npm i -g xanima`; the `sharpwave` bin is
   kept as an alias) back to `openclaw.json`.
3. `openclaw gateway restart`.

Same brain db, same schema, no migration in either direction.

---

## Development

```bash
nvm use                # Node 24 (.nvmrc); the openclaw dev dependency needs >= 24.16
npm ci                 # lockfile install; xanima-core comes from vendor/xanima-core-<version>-<engine commit>.tgz
                       # (package.json allowScripts lets npm 11 build the native modules)
npm run typecheck
npm test               # vitest — mock-api hook harness, local and remote
npm run build          # esbuild → dist/index.js (single file, xanima-core inlined), dist/upgrade.js, dist/control-ui/<hash>/
```

`npm run build` rewrites the `controlUi` entry in `openclaw.plugin.json` with
the content hash of the UI bundle; commit that change together with the source
change. CI (`.github/workflows/ci.yml`) runs typecheck, tests and the build on
Node 24 and fails if the committed hash is stale.

The engine (`xanima-core`) is bundled into `dist/index.js` at build time. To
pick up engine changes, build and `npm pack` `packages/core` in the xanima
repo, drop the tarball into `vendor/` named `xanima-core-<version>-<engine
commit>.tgz` (tracked although `*.tgz` is ignored), point the `xanima-core`
devDependency at it and run `npm install` so the lockfile follows. The vendored
engine is currently `xanima-core` 0.6.0 (`vendor/xanima-core-0.6.0.tgz`); add an
engine-commit suffix to the file name only when vendoring an unreleased engine.

### Remote-mode tests

The suites under `test/remote/` (and the remote half of
`test/identity-provenance.test.ts`) start a **real** `xanima-server` child
process. They skip with a warning unless `SHARPWAVE_SERVER_CLI` (or
`XANIMA_SERVER_CLI`) points at a built server; set
`OPENWAVE_REQUIRE_REMOTE_TESTS=1` to make that a failure. Build it from the
xanima repo (formerly sharpwave):

```bash
git clone https://github.com/Enlightened-Republic/sharpwave ../sharpwave
cd ../sharpwave
printf 'allow-scripts=better-sqlite3,sqlite-vec,esbuild\n' > .npmrc   # npm >= 11
npm ci
npm run build --workspace xanima-core
npm run build --workspace xanima-server
cd -
SHARPWAVE_SERVER_CLI=../sharpwave/packages/server/dist/cli.js npm test
```

The default location is `../sharpwave/packages/server/dist/cli.js` next to
this checkout. CI does not build the server, so the remote suites skip there.

## Release notes

- **0.6.0** — engine `xanima-core` 0.6.0 (schema v27):
  forgetting is dormancy (`forgetting`), plans carried out become verified
  procedures (`procedures`, `procedureVerifyAfter`), `brain_query
  include_dormant`, `brain_expand source_turns`, the dedupe merge never
  downgrades a belief, and identity changes only with the owner
  (`identity.changesFrom`). Plugin side: with no `commands.ownerAllowFrom` a
  clean conversational turn counts as the owner's; `brain_review accept |
  reject` works from the owner's conversation in local mode (held identity
  proposals, quarantined writes, imported changes); `identityMirror` follows
  applied changes only; the new settings are in the manifest.
  Also in 0.6.0 (audit fixes): the `openwave:consolidation` cron no longer
  wakes the agent (`wakeMode: "next-heartbeat"`; a leftover `"now"` job is
  switched in place) and the in-process pass runs once, on the job's
  finished-ok event; Control UI persona overrides are applied to every
  local-mode engine call (they were persisted but never read); `brain_reset`
  is refused unless `allowAgentReset`; the remote per-turn hook requests
  recall, goals and status in parallel under one `remoteTimeoutMs`; extracted
  facts survive a service outage; a lifecycle `restart` no longer re-injects a
  live session's bootstrap and the sleep timers re-arm if no `gateway_start`
  follows; the memory corpus supplement refuses unidentifiable callers;
  `allowAgentReset`, `rooms`, `roomRecallMax` and the `soul*` settings are in
  the manifest; CI workflow, `.nvmrc`, `engines`, `allowScripts`.
- **0.5.0** — shared rooms on the brain service (`brain_room`, `brain_publish`,
  `brain_unpublish`, `brain_room_query`, `brain_subscribe`), `brain_focus` and
  injection categories, the poisoning quarantine, and `brain_identity` with
  plugin-attested provenance. Needs `xanima-server` 0.5.0 for rooms.
- **0.4.0** — portable Soul Package: `brain_export_soul` for the agent's own
  brain, and the `brain_review` queue for imported identity / goal changes.
- **0.3.0** — reflection, experience replay, hypotheses / questions /
  assumptions, commitments and plans (park / resume briefings), meta-tools.
  Needs `xanima-server` 0.3.0 for the new tools in remote mode.
- **0.2.0** — decision ledger, versioned goals with drift detection, alignment
  notes and goal triggers (`[BRAIN: goals]` block via `brain_turn_context`).
  Needs `xanima-server` 0.2.0 in remote mode (older services: the goals block
  is skipped silently).
- **0.1.0** — openwave becomes **Xanima**: package `xanima-openclaw`, plugin id
  `xanima`, engine `xanima-core`; belief foundation (confidence, source, status,
  sensitivity, relative-time labels, `brain_retract`, `brain_status`, `as_of`
  queries).

## License

MIT
