# Xanima for OpenClaw (`xanima-openclaw`, formerly openwave)

**Autonomic long-term memory and agent continuity for [OpenClaw](https://openclaw.ai) agents.**

Xanima hooks OpenClaw's turn lifecycle. On every session start, every turn,
every heartbeat and every compaction it pulls the memories relevant to what the
agent is about to do out of that agent's brain and **injects them into context
automatically, with no tool call**. Identity and goals ride in as a
never-compacted system header; query-relevant recall, always-on procedural
rules and a last-24h activity digest ride in as prepended context. The agent
wakes up already knowing.

It also runs the sleep system in-process on timers (awake replay, LLM fact
extraction, embedding sweeps) and the nightly consolidation pass, so the graph
keeps improving between sessions without anything calling it.

The engine is [`xanima-core`](https://github.com/Enlightened-Republic/sharpwave/tree/main/packages/core),
the same memory engine behind the `xanima` MCP server and the `xanima-server`
brain service (sharpwave repo). Use the MCP server for Claude Code / Cursor /
Claude Desktop. Use this plugin for OpenClaw: it does everything the MCP server
does, plus the automatic per-turn injection and the in-process sleep system
that an MCP server structurally cannot.

> **Status: pre-release.** Nothing is published to npm or ClawHub yet; install
> from source (below). Plugin id `xanima` (manifest `legacyPluginIds: ["openwave"]`),
> package `xanima-openclaw`, engine `xanima-core` 0.5.0 (vendored tarball).
> The `brain_*` tool names are unchanged and permanent.

---

## Changelog

### Unreleased (audit fixes on top of 0.5.0)

- **Consolidation cron no longer wakes the agent.** `openwave:consolidation`
  is registered with `wakeMode: "next-heartbeat"` instead of `"now"`: on
  OpenClaw a main-session systemEvent job with `wakeMode: "now"` requests an
  immediate heartbeat, i.e. an LLM turn every night at 04:30 for nothing. A
  job left behind with `"now"` by an older version is switched in place. The
  in-process pass now runs on `cron_changed` **finished + ok** only; the old
  "looks like a fire" match also fired on `started`, running the pass twice.
- **Persona overrides are applied.** The Control UI's per-agent overrides
  (`personaOverrides.<agentId>`) were persisted but never read on any engine
  path. Every local-mode engine call (hooks, tools, timers) now uses the
  agent's effective config.
- **`brain_reset` is operator-gated.** New `allowAgentReset` (default `false`):
  the engine's only guard was `confirm` equal to the agent's own id, which it
  knows, so a prompt injection could wipe the brain. The tool stays registered
  and answers with a clear refusal until the operator opts in. Local and remote.
- **Remote per-turn hook fits its budget.** Recall, the goals block and the
  status footer are requested in parallel under one `remoteTimeoutMs` budget
  (they were sequential, up to 3x the budget, and the hook timed out and failed
  open). Provisioning is raced against the budget and continues in the
  background. A transport failure no longer caches an empty status footer.
- **Extracted facts are not dropped on an outage.** In remote mode the rest of
  a batch waits in memory (bounded) for the next harvest when the service goes
  down mid-write; locally one bad fact no longer aborts the batch.
- **Sleep timers can't stay dead.** A lifecycle `restart` cleanup releases the
  timers (as the host contract asks) but no longer clears per-session
  bookkeeping, so a live session is not handed its bootstrap again. If no
  `gateway_start` follows, the next turn re-arms the timers (`sleep_system
  rearmed` in the log).
- **Memory corpus supplement follows the tool rule.** A search from a caller
  it cannot identify returns nothing instead of reading the first configured
  agent's brain.
- Manifest: `allowAgentReset`, `rooms`, `roomRecallMax` and the six `soul*`
  engine settings are now operator-settable (the schema is closed, so unlisted
  keys were rejected). Docs, package metadata and UI labels say Xanima. CI
  workflow, `.nvmrc` (Node 24), `engines`, `allowScripts` for npm 11.

### 0.5.0 rooms, focus, quarantine, `brain_identity`

Remote mode proxies the room tools of `xanima-server` 0.5.0: `brain_room`
(list / members / conflicts; create with a `room-admin` token; invite / revoke
for room admins), `brain_publish`, `brain_unpublish`, `brain_room_query` and
`brain_subscribe`. Per-turn recall asks the service with `inject: true`, so up
to `roomRecallMax` items from subscribed rooms show up tagged
`[type·room·writer]`, and the service applies `brain_focus`,
`injectionCategories` and the sensitivity labels. In local mode the room tools
answer that rooms need the brain service. `brain_focus {suppress: [...], ttl}`
works in both modes and only shapes recall. Settings: `quarantine` (`log` |
`enforce` | `off`), `injectionCategories`, `focusDefaultTtl`, `identity.*`,
`identityMirror`, `identityTrustedTools`. See [Tools](#tools).

### 0.4.0 Soul Package

`brain_export_soul` exports the agent's **own** brain as a portable
`xanima-soul/1` package; `brain_review` gains a queue mode for identity /
value / goal changes that arrived through an import or a merge. Import, fork
and merge are operator steps on the brain host (`xanima-server soul ...`).
Remote mode: `soulHeader` shows the brain's identity line each turn.

### 0.3.0 reflection, replay, open items, commitments, plans, meta-tools

Tools `brain_reflect`, `brain_replay`, `brain_hypothesis`, `brain_question`,
`brain_list_open`, `brain_commit`, `brain_commitments`, `brain_plan`,
`brain_changes`, `brain_conflicts`, `brain_briefing`, `brain_forget_impact`.
The agent's own "I think … because …", "open question: …" and "I'm assuming …"
become drafts. The `[BRAIN: goals]` block may carry one overdue-commitment
nudge and one relevant open question. Settings: `reflection`, `reflectionLlm`,
`reflectionWindowDays`, `openItemCapture`, `openItemDraftTtlDays`,
`openItemSurfacing`, `commitmentNudges`, `replayMaxChars`, `metaToolMaxChars`.

### 0.2.0 decision ledger, goals, drift

Tools `brain_record_decision`, `brain_update_decision_outcome`,
`brain_query_decisions`, `brain_set_goal`, `brain_update_goal`,
`brain_list_goals`. Each turn may get one small `[BRAIN: goals]` block: an
alignment note after the drift pass found a stalled or conflicting goal (acked
after the first real reply; memory-tool-only turns do not use it up) and goal
lines whose keyword / time trigger fired. Settings: `decisionLedger`,
`decisionAutoExtract`, `decisionLessonPromotion`, `decisionBoost`,
`intentDriftCheck`, `driftDays`, `goalTriggers`, `alignmentNoteMaxTokens`,
`decisionDraftTtlDays`, `lessonMergeSimilarity`. Remote mode: agents `"*"`,
`autoProvision`.

### 0.1.0 openwave becomes Xanima; belief foundation

Every memory carries a confidence, a source, a status and a sensitivity.
Recall lines say when a memory was learned and mark low confidence `(?)` and
disputed beliefs. New tools `brain_retract`, `brain_status`; `brain_supersede`
takes a reason; `brain_query` takes `as_of`. Settings: `beliefMetadata`,
`relativeTimeLabels`, `selfStatus`, `lowConfidenceThreshold`, `sleepBeliefReview`.

**Upgrading from openwave 0.2.x** (one-release compatibility window):

- An empty `plugins.entries.xanima` falls back to the old `plugins.entries.openwave.config`
  with a deprecation warning. Run `xanima-openclaw-upgrade --config <openclaw.json>` (dry run)
  then `--write` to copy the block to `plugins.entries.xanima` and disable (not delete)
  `plugins.entries.openwave`; a timestamped backup is written first.
- `$OPENWAVE_BRAIN_TOKEN` still works (warning); use `$XANIMA_BRAIN_TOKEN`.
- Local brains live in `~/.xanima/<agent>/brain.db`; `~/.sharpwave` is used until
  `xanima-server migrate` copies it (the old folder is never moved or deleted).
- The host cron id stays `openwave:consolidation`.

---

## Install

### From source (the only option until it is published)

Needs Node 24.16+ (`.nvmrc`; OpenClaw 2026.9.x requires it too).

```bash
git clone https://github.com/Enlightened-Republic/xanima-openclaw
cd xanima-openclaw && npm ci && npm run build
```

Then point `plugins.load.paths` at the checkout directory (not `dist/index.js`;
OpenClaw reads `openclaw.plugin.json` next to it):

```jsonc
"plugins": {
  "load": { "paths": ["/abs/path/to/xanima-openclaw"] }
}
```

### From npm (once published)

```bash
openclaw plugins install npm:xanima-openclaw --force --accept-capabilities
cd ~/.openclaw/npm/projects/xanima-openclaw && npm rebuild better-sqlite3
```

`--force` acknowledges an npm (non-ClawHub) source. The `npm rebuild` step is
**required**: OpenClaw's plugin installer runs `npm install --ignore-scripts`,
so `better-sqlite3`'s native binary is not fetched during install, and every
`db.init` fails with "Could not locate the bindings file" without it. Re-run it
after any `openclaw plugins update`.

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

Then restart the gateway (`openclaw gateway restart`, a full restart) and
confirm from the log:

```
[xanima] {"op":"register","outcome":"ok","agents":<N>,"tools":43,"engine":"xanima-core",...}
[xanima] {"op":"gateway_start","outcome":"ready",...}
```

**`hooks.allowConversationAccess: true` is required.** Xanima is a non-bundled
plugin and its `before_prompt_build` / `agent_turn_prepare` / `llm_output` /
`agent_end` hooks read conversation content.

**`config.agents` is required and has no safe default on a multi-agent gateway.**
Every hook and tool call guards on the served agent set; an agent not listed
gets no injection, no episode logging, no sleep system. List every agent you
want served, or use `"*"` (see [Automatic agents](#automatic-agents-and-provisioning-remote-mode)).

**Compatibility:** `pluginApi >= 2026.5.0`, `minGatewayVersion 2026.5.0`;
built and tested against OpenClaw 2026.9.8.

---

## Configuration

The config is `xanima-core`'s `BrainConfig` plus the host-only fields below.
Everything under `plugins.entries.xanima.config` is merged over the defaults
and passed into the engine. The manifest schema is closed
(`additionalProperties: false`): an unknown key is rejected by the host.

| field | type | default | meaning |
|---|---|---|---|
| `agents` | `string[]` \| `"*"` | `["main"]` | **Required.** Agent ids to serve. Local mode routes each to `~/.xanima/<id>/brain.db`. |
| `enabled` | `boolean` | `true` | `false` (or `entries.xanima.enabled: false`): `register` returns immediately, no tools, no hooks. |
| `allowAgentReset` | `boolean` | `false` | Let the agent call `brain_reset` on its own brain. Off by default: the engine's only guard is `confirm` = the agent's own id, which it knows, so a prompt injection could wipe the brain. Local and remote. |
| `llmExtractionEnabled` | `boolean` | `false` | `true`: `message_received` / `llm_output` episodes at or above `llmExtractionMinImportance` are queued for LLM fact extraction into graph nodes. `false`: heuristic extractor only. |
| `llmExtractionMinImportance` | `number` | `0.4` | Importance floor for queueing an episode for extraction. |
| `skipSystemTurns` | `boolean` | `true` | Skip OpenClaw system turns on every memory-writing path. See [System turns](#system-turns). |
| `systemTurnPatterns` | `string[]` | `[]` | Extra case-insensitive regexes; a turn whose trimmed text matches is skipped like a system turn. Invalid entries are ignored (warned once). |
| `ingestionModel` | `string` | `"openrouter/deepseek/deepseek-v4-flash"` | Model for LLM fact extraction and generative REM. |
| `openRouterApiKey` | `string` | `$OPENROUTER_API_KEY` / `""` | OpenRouter key for engine LLM calls. Empty: extraction and generative REM degrade to heuristic mode. Prefer the env var over putting the key in `openclaw.json`. |
| `curatedTierDedupe` | `boolean` | `true` | When the agent's workspace has a non-empty `MEMORY.md` / `USER.md` (OpenClaw memory-core), the graph's durable identity / goals are not injected a second time. |
| `consolidationCron` | `string` | `"30 4 * * *"` | Host cron expression for `openwave:consolidation`. See [Sleep system](#sleep-system-and-the-consolidation-cron). |
| `consolidationCronEnabled` | `boolean` | `true` | `false`: the host cron is not registered (the in-process timers still run). |
| `personaOverrides` | `object` | `{}` | Per-agent overrides of the numeric tunables, written by the Control UI page. See [Persona overrides](#persona-overrides-control-ui). |

Engine (`BrainConfig`) fields you can also override (defaults from
`core.DEFAULT_CONFIG`): `contextBudget` (2000), `workingMemorySlots` (7),
`spreadingActivationHops` (1), `activationThreshold` (0.1),
`inhibitionStrength` (0.6), `recallTopK` (10), `bootstrapTopK` (15),
`efDefault` (2.5), `retrievabilityFloor` (0.05), `consolidationTimeGateHours`
(4), `consolidationEpisodeGate` (10), `pruneAfterDays` (90), `remModel`
(unset: falls through to `ingestionModel`), `embeddingModel`
(`"ollama/qwen3-embedding:0.6b"`, 1024-dim; Ollama at `$OLLAMA_BASE_URL`),
`skillEvolution` (false), `skillEvolveMinPatternCount` (5),
`workspaceSkillsDir`, `brainDocsDir`, the 0.1.0 to 0.5.0 feature switches
listed in the changelog, the `soul*` export settings and `rooms` /
`roomRecallMax`. Every key, with its description, is in
`openclaw.plugin.json`.

Env vars the engine reads directly: `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL`,
`XANIMA_DATA_DIR` (brain-db parent dir; `SHARPWAVE_DATA_DIR` still read with a
deprecation warning) and `XANIMA_DB_PATH` (exact file).

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
(`src/system-noise.ts`) gates every path that writes memory: episode append
(local and remote), the LLM-extraction queue, and therefore heuristic SWS, which
only reads the episode log.

Signals, strongest first (OpenClaw 2026.9.x):

1. **Structured**: agent-hook `ctx.trigger` `heartbeat` or `memory`;
   `ctx.inputProvenance.kind === "internal_system"` (any `sourceTool` except
   `cron`); isolated heartbeat session keys ending in `:heartbeat`.
2. **Text fallback**: user turns starting with an internal wake marker
   (`[OpenClaw heartbeat poll]`, `[OpenClaw exec completion]`, `[OpenClaw cron
   wake]`, `[OpenClaw session event]`), the default / legacy heartbeat prompt,
   exec / cron event prompts, or bodies made only of `System:` event lines;
   assistant replies that are, or start with, `NO_REPLY` / `HEARTBEAT_OK`.
3. **Pairing**: after a skipped user turn, the next reply in that session is
   skipped too.

Skipped turns are **not appended at all** (no tag). Isolated automation
(`cron`) turns are not skipped; they keep the importance clamp (0.1, below
extraction). Normal turns that merely mention heartbeats are kept. The test
suite checks the markers against the installed `openclaw` package.

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

---

## Remote brain mode

By default the plugin opens `~/.xanima/<agent>/brain.db` in-process
(`brainMode: "local"`). With `brainMode: "remote"` it talks to the
**Xanima brain service** (`xanima-server`, `packages/server` in the sharpwave
repo, unpublished) over MCP Streamable HTTP, using a per-agent bearer token.
The service owns storage *and* sleep.

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
| `brainTokenFile` | | **Preferred.** File holding the token from `xanima-server token mint`. `~` and `{agentId}` are expanded, so one entry serves several agents. UTF-8 / UTF-16 / BOM all accepted. |
| `$XANIMA_BRAIN_TOKEN` | | Used when `brainTokenFile` is unset (single agent only). `$OPENWAVE_BRAIN_TOKEN` still read, deprecated. |
| `brainToken` | | Inline token (discouraged: it lands in `openclaw.json`). Single agent only. |
| `sharedRecall` | `true` | Per-turn recall also searches the shared brain; shared hits are tagged `[type·shared]`. |
| `remoteTimeoutMs` | `2500` | Budget per service call **and** for the per-turn hook as a whole: recall, the goals block and the status footer are requested in parallel. A slow or dead service costs a turn at most this, then the client backs off (2 s to 60 s) and fails fast. |

The token is never logged; only its source (`file` / `env` / `inline`) is. A
rejected token logs an `error` line containing `BAD BRAIN TOKEN` and the
`getBrainConnection` settings action reports `status: "unauthorized"`.

**What works remotely:** 39 tools proxied 1:1 (everything in [Tools](#tools)
except the four local-only ones); per-turn recall (private + shared + subscribed
rooms) in the same `[BRAIN: on your mind …]` block with the curated-tier
dedupe; the `[BRAIN: goals]` block and the identity header (`soulHeader`);
episode writes via `brain_episode_append` when the service advertises it;
LLM-extraction facts written to the service on `session_end` and hourly (a
batch interrupted by an outage waits in memory for the next harvest); the
memory-corpus supplement; `brain_identity` provenance attested by the plugin.

**Disabled in remote mode** (no service equivalent): local brain.db,
in-process sleep timers, the `openwave:consolidation` host cron (an existing
one is removed), the session bootstrap block, the procedural-rules block, the
last-24h activity block, proactive monitor / working memory / coactivations /
dopamine, VALOR scoring, subconscious tick, compaction graph handling,
temporal edges from extraction, persona overrides, and the tools
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

- The agent set is read from OpenClaw's **live** config (`agents.entries` or
  `agents.list`) on each turn, at `gateway_start`, and every `rosterPollMs`. An
  agent added with `openclaw agents add` is served on its first turn, with no
  gateway restart. In local mode `"*"` is resolved once at register.
- With `autoProvision`, an agent that has no token file triggers
  `brain_provision_agent` on the service, which creates the agent's brain and
  mints a token with its own configured scopes (never admin). The plugin
  writes the token file atomically (POSIX `0600`; on Windows the temp file is
  locked with `icacls` to the current user + SYSTEM before the rename, and
  nothing is written if that fails) and connects right away.
- `provisionTokenFile` should hold a token minted with **only** the
  `provision` scope. That scope can't read or write any brain, and the server
  accepts it only on 127.0.0.1.
- Idempotent: agents with a token file are never re-provisioned. Service down:
  the turn proceeds without memory and provisioning retries with backoff (2 s
  up to 5 min). Tokens are never logged.

---

## Tools

The plugin registers **43** tools: the 38 `brain_*` tools of `xanima-core`'s
unified tool module plus the 5 room tools (`brain_room`, `brain_publish`,
`brain_unpublish`, `brain_room_query`, `brain_subscribe`; in local mode they
answer that rooms need the brain service). Definitions and executors come from
the engine, so the plugin and the MCP server can never expose a drifted schema;
the manifest's `contracts.tools` and the registered set are pinned by a test.

**Result shape.** Every tool (local and remote) returns
`{ content: [{ type: "text", text }], details: { text, error?, data? } }` and
declares that `details` shape as its `outputSchema`. This matters because
OpenClaw's Code Mode and Tool Search hand the model **only** `details`.

Most memory work needs **no** tool call. The tools are for deliberate deep
recall (`brain_query`, with `as_of` for past beliefs), deliberate writes
(`brain_write`, `brain_supersede` / `brain_retract` with a reason),
introspection (`brain_status`, `brain_stats`, `brain_briefing`) and the
continuity tools listed in the changelog.

**`brain_reset`** wipes the agent's own brain (`confirm` = its own agent id; a
timestamped backup is taken first; learned-state tables are cleared, never
dropped). It is **refused unless `allowAgentReset: true`**, because the agent
knows its own id and a prompt injection could otherwise trigger it. Operators
reset with the `xanima-server` / sharpwave CLI.

**Soul Package (0.4.0).** `brain_export_soul` exports the agent's own brain as
a `xanima-soul/1` package (summary by default, `format: "json"` for the
package). Sensitive items and the shared brain are never exported through the
tool. `brain_review` has a queue mode (`action: "list" | "show"`); `accept` /
`reject` need an admin. Import, fork and merge are operator steps on the brain
host; `brain_import_soul` is never offered to the agent.

**Rooms, focus and quarantine (0.5.0).** See the changelog; sharpwave
`docs/rooms.md` and `docs/security-model.md`.

**Agents evolve their own identity (`brain_identity`).** The agent can add,
change or remove a line of its identity header or a core value with a short
reason (`get` / `history` to read). A change applies at once, is versioned and
shows in the header from the next turn; the operator can revert it. In a run
where a non-memory tool returned output, the run came from a non-owner sender
(with `commands.ownerAllowFrom` set), or the new text repeats recent tool
output, the change is **refused** and kept as a candidate knowledge note. The
plugin, not the model, attests the provenance. Switches under `identity`:
`selfEdit`, `refuseUntrusted`, `saveRefusedAsNote`, `locked`,
`maxChangesPerDay`, `maxChars`, `requireAttestation`. Plugin settings:
`identityMirror` (write applied changes back to the workspace `IDENTITY.md` /
`SOUL.md`) and `identityTrustedTools`.

---

## Brain databases

Brain dbs live at `~/.xanima/<agentId>/brain.db` (plus SQLite `-wal` / `-shm`
sidecars); `~/.sharpwave/<agentId>` is used until `xanima-server migrate` has
copied it. Redirect with `XANIMA_DATA_DIR` (parent dir) or `XANIMA_DB_PATH`
(exact file).

The plugin and the `xanima` MCP server read and write the **same files** with
the **same engine code**, so an agent can be moved between them with no data
migration. First open runs the additive-only schema migration to **v25**.

## Rollback (to the MCP server)

1. `openclaw plugins disable xanima` (or `entries.xanima.enabled: false`).
2. Add the `mcp.servers.xanima` entry back to `openclaw.json`.
3. `openclaw gateway restart`.

Same brain db, same schema, no migration in either direction.

---

## Development

```bash
nvm use                # Node 24 (.nvmrc); the openclaw dev dependency needs >= 24.16
npm ci                 # lockfile install; package.json allowScripts lets npm 11 build the natives
npm run typecheck
npm test               # vitest: mock-api hook harness + the vendored engine
npm run build          # esbuild: dist/index.js (engine inlined), dist/upgrade.js, dist/control-ui/<hash>/
```

`npm run build` rewrites the `controlUi` entry in `openclaw.plugin.json` with
the content hash of the UI bundle; commit that change with the source change.
CI (`.github/workflows/ci.yml`) runs typecheck, tests and the build on Node 24
and fails if the committed hash is stale.

The engine (`xanima-core`) is a vendored tarball (`vendor/`, tracked despite
`*.tgz` being ignored) bundled into `dist/index.js` at build time; replace the
tarball and the `file:` reference in `package.json` to pick up engine changes.

### Remote-mode tests

The suites under `test/remote/` (and the remote half of
`test/identity-provenance.test.ts`) start a **real** `xanima-server` child
process. They skip with a warning unless `SHARPWAVE_SERVER_CLI` (or
`XANIMA_SERVER_CLI`) points at a built server; set
`OPENWAVE_REQUIRE_REMOTE_TESTS=1` to make that a failure. Build it from the
sharpwave repo:

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

## License

MIT
