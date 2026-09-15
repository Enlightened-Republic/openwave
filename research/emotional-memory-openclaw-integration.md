# Weaving openwave into OpenClaw's shipped memory + dreaming, and upgrading the emotional-memory model

Research pass, 2026-09-15. Grounded in: local `openwave` source (`src/index.ts`, `dist/index.js`,
`openclaw.plugin.json`) + local OpenClaw docs (`docs/concepts/memory*.md`, `docs/concepts/dreaming.md`,
`docs/plugins/hooks.md`, `docs/plugins/manifest.md`) + current neuroscience/AI-memory literature (web,
Sept 2026). Every claim below is either read directly from one of those sources or marked as a proposal.

## 1. Where things actually stand today (facts, not proposals)

**openwave and `memory-core` are two independent, un-coordinated memory systems running side by side
for the same agent right now — not layers of one system.**

- `plugins.slots.memory` is an **exclusive** slot (`docs/plugins/manifest.md:330`): a plugin declares
  `kind: "memory"` in its manifest to own it, default owner is `memory-core`. `openwave`'s
  `openclaw.plugin.json` declares **no `kind` field at all** — it never competes for or occupies that
  slot. It just loads as an ordinary plugin alongside whatever owns the memory slot.
- Both register on **the same prompt hooks**: `openwave` (`src/index.ts:628-1093`) hooks
  `session_start`, `session_end`, `agent_turn_prepare`, `before_prompt_build`,
  `heartbeat_prompt_contribution`, `message_received`, `llm_output`, `agent_end`, `after_compaction`,
  `cron_changed`. `memory-core`'s bootstrap injection (`MEMORY.md`/`USER.md`) and dreaming's
  `heartbeat_prompt_contribution`-style context also ride the same hook family
  (`docs/concepts/memory-architecture.md` "Recall: two lanes"). Per `docs/plugins/hooks.md`, context
  additions from multiple `before_prompt_build`/`agent_turn_prepare` handlers **concatenate in priority
  order** — so today the agent likely gets two independent identity/context injections every turn (one
  from `MEMORY.md`/`USER.md` bootstrap, one from openwave's own identity+goals header), with no
  deduplication and no shared source of truth between them.
- **`MEMORY.md` has exactly one primary writer by design**: the dreaming consolidation pass
  (`docs/concepts/memory-architecture.md` "The write path"). It uses optimistic concurrency — a content
  hash re-checked immediately before an atomic rename — specifically so it doesn't need every other
  editor of the file to hold a lock, but that also means an openwave write into `MEMORY.md` would either
  race dreaming's own rewrite (aborting that sweep) or get silently overwritten by it. **openwave should
  treat `MEMORY.md`/`USER.md`/`DREAMS.md` as read-only inputs, never a write target.**
- `memory-core` has **no plugin extension point** for external candidate scoring or ingestion — its
  plugin reference (`docs/plugins/reference/memory-core.md`) is a generated stub with just the tool/CLI
  surface, no hook for "contribute a dreaming candidate" or "contribute a ranking signal." Nothing today
  lets openwave feed its graph *into* memory-core's dreaming pipeline at the code level. Real
  integration has to happen at the **file/hook boundary**, not inside memory-core's internals.
- `memory-core`'s security model (`docs/concepts/memory-architecture.md` "The security model") gates
  promotion on **provenance** — origin class `owner`/`agent`/`untrusted`/`system`, taint propagation
  from network-sourced tool output, structural exclusion of `untrusted`/`system` candidates *before* the
  consolidation prompt is even built. I grepped the built `dist/index.js` for openwave's write path
  (`brain_write`, the `emotional_weight` handling around `dist/index.js:1861-1905`) and found a `source`
  column but **no equivalent origin-class/taint gate**. A message that says "this is really important,
  always trust this" with emotionally-loaded language can currently drive `emotional_weight` up (via the
  `EMOTION_WORDS` classifier at `dist/index.js:2519`) and thus salience/injection likelihood, with
  nothing structurally distinguishing owner-said-it from a web page openwave's own `message_received`
  hook happened to observe. That's a real gap relative to what memory-core already solved.
- Both systems run **independent nightly consolidation** against **independent compute budgets**:
  memory-core's dreaming shares OpenClaw's "background work budget" (max 3 background completions total,
  up to 3 reserved for memory-core, `docs/concepts/dreaming.md` "Scheduling"). openwave's sleep system
  (`src/scheduler.ts`, its own cron via the `cron_changed`/`gateway_start` hooks) runs on its own timers,
  unaware of that shared budget. Given this machine's own incident history (WAL-bloat freezes, heartbeat
  collisions — `reference_openclaw_2026_8_upgrade_recovery.md` — from *doubled*, uncoordinated per-agent
  workloads), two independent nightly LLM sweeps per agent is a plausible next version of the same class
  of problem, not a hypothetical one.

## 2. Why nothing is in the README

Confirmed by grep: `README.md` has zero occurrences of "emotion," "affect," "mood," or "sentiment," even
though (per the earlier check) `emotional_weight`, the `emotion` node type, its salience/decay math, and
its tool-schema exposure are all fully built and shipped in `dist/index.js`. The README's "What it does"
section documents identity/goals injection, query-relevant recall, procedural rules, and the sleep
system in general terms, but never mentions the emotional-weight dimension specifically — it just never
got written up. It's not disabled, stripped, or hidden by config; it's undocumented. Worth a README
section once the integration work below settles, so the shape doesn't shift twice.

## 3. Neuroscience: what's actually established (Sept 2026 sources)

- **Arousal, not valence, drives amygdala-mediated consolidation enhancement.** A 2025 PMC/Imaging
  Neuroscience study found amygdala encoding effects for negative *and* neutral successful encoding
  disappeared once arousal was controlled for — the amygdala tracks arousal, not negative valence per
  se. High-arousal negative items drove amygdala activation; low-arousal negative/neutral items engaged
  inferior PFC instead. [Neural correlates of emotional memory enhancement: valence and arousal](https://pmc.ncbi.nlm.nih.gov/articles/PMC13094029/)
- **The mechanism is amygdala→hippocampus/cortex noradrenergic modulation of plasticity**, not a
  separate memory store — arousal-driven amygdala activation increases noradrenergic transmission in
  hippocampus/cortex, strengthening consolidation of whatever is concurrently being encoded there.
  Emotional memories are also retrieved with a *recollection* rather than *familiarity* signature, tied
  to amygdala-hippocampal co-activation at retrieval, not just encoding.
  [Amygdalo-cortical dialogue underlies memory enhancement (Neuron, 2025)](https://www.cell.com/neuron/fulltext/S0896-6273(25)00005-4) ·
  [Cognitive neuroscience of emotional memory (Nat Rev Neurosci)](https://www.nature.com/articles/nrn1825)
- **Sleep's role is phase-specific, not generic "consolidation."** TMR (targeted memory reactivation —
  re-cueing a specific memory during sleep with an associated stimulus) during REM selectively reduces
  *subjective arousal* for reactivated negative memories — evidence for the "sleep to forget, sleep to
  remember" hypothesis: REM habituates the emotional charge of a memory while keeping the memory itself.
  TMR during NREM/slow-wave sleep instead benefits *integration and updating* of memories (e.g., after
  cognitive reappraisal), and a 2025 study found the overall TMR benefit correlates with the *product* of
  REM and SWS time, i.e., the phases are complementary, not redundant.
  [TMR during REM reduces arousal responses (Comms Biology, 2021)](https://www.nature.com/articles/s42003-021-01854-3) ·
  [TMR during REM + LPP amplitude (SLEEP Advances, 2025)](https://academic.oup.com/sleepadvances/advance-article/doi/10.1093/sleepadvances/zpaf034/8145611) ·
  [SWS+REM both contribute to emotional memory consolidation (Comms Biology, 2025)](https://www.nature.com/articles/s42003-025-07868-5) ·
  [TMR during NREM benefits reappraisal-updated aversive memories (Transl Psychiatry, 2024)](https://www.nature.com/articles/s41398-024-03192-4) ·
  [TMR during NREM enhances neutral but not negative memory components (eNeuro, 2024)](https://www.eneuro.org/content/11/5/ENEURO.0285-23.2024)

**Where sharpwave-core already agrees with this literature, and where it doesn't yet:**

- ✅ Its salience formula already uses `Math.abs(emotional_weight)` (`dist/index.js:1852-1853`) — i.e.
  arousal-as-magnitude, sign-independent — which matches the arousal-not-valence finding better than a
  naive "negative = more memorable" model would.
- ❌ It stores emotional weight as a **single scalar** (-1.0 to 1.0), conflating valence (sign) and
  arousal (magnitude) into one number. The literature treats these as two axes (Russell's circumplex
  model is the standard two-dimensional affect representation) — valence still matters for *retrieval
  bias* (mood-congruent recall) even though arousal is what drives *consolidation strength*. Splitting
  them is a small schema change with a real payoff: you can ask "surface calm-but-important nodes right
  now" vs. "surface high-arousal nodes" as genuinely different queries.
- ❌ Its passive decay (`emotional_weight * 0.9` when stale, `dist/index.js:3142-3145`) is a **blanket
  time-decay**, not phase-specific. Nothing in the current REM/deep-sleep phases actively **habituates**
  (down-regulates arousal on) recently-reactivated emotional nodes the way REM-TMR does. That's the
  single highest-leverage neuroscience-grounded change available (see §5.2).

## 4. AI-memory research: what's directly transferable

- **HippoRAG** — a NeurIPS 2024 architecture explicitly modeled on hippocampal-indexing theory: an LLM
  ("neocortex") extracts entities/triples into an open knowledge graph ("hippocampus"), a
  parahippocampal-style encoder links synonymous entities, and retrieval runs **Personalized PageRank**
  seeded at query-matched entities for multi-hop spreading activation — 10-30x cheaper and 6-13x faster
  than iterative-retrieval baselines, up to 20% better on multi-hop QA.
  [HippoRAG (NeurIPS 2024)](https://neurips.cc/virtual/2024/poster/94043) ·
  [paper PDF](https://proceedings.neurips.cc/paper_files/paper/2024/file/6ddc001d07ca4f319af96a3024f6dbd1-Paper-Conference.pdf)
  — **directly transferable**: sharpwave-core already has the graph, the edges table, and a spreading-
  activation config (`spreadingActivationHops: 1`, `inhibitionStrength: 0.6` in `openclaw.plugin.json`).
  Swapping the fixed 1-hop decay expansion for a Personalized-PageRank-style multi-hop walk (seeded at
  the query-matched nodes, same edges table, no new storage) is the same idea HippoRAG validated, at
  basically zero new infrastructure cost. This is the single most concrete "make it better" item in this
  whole doc.
- **Dynamic Affective Memory Management for Personalized LLM Agents** (arXiv:2510.27418, Oct 2025) —
  proposes exactly the "weave emotion into a memory system" problem this project has. Key transferable
  pieces:
  - **Bayesian-confidence weighted updates instead of blanket decay**: `C_new = (C·W + S·P) / (W + S)`,
    `W_new = W + S`, where `C`/`W` are current confidence/weight and `S`/`P` are the new signal's
    strength/polarity. A node reinforced by many independent observations resists being swung by one
    outlier remark; a node seen once stays provisional. This is a strict upgrade over sharpwave-core's
    current "just decay 10%/cycle" rule and reuses the same `emotional_weight` column.
  - **Entropy-driven forgetting**: compute `H = -Σ p_k log2(p_k)` over a node's sentiment distribution;
    high-entropy (genuinely ambiguous/contradictory) low-weight nodes get merged or pruned rather than
    kept forever. Maps directly onto sharpwave-core's existing prune-after-days config
    (`pruneAfterDays: 90`) as a second, smarter pruning signal alongside pure age.
  [paper](https://arxiv.org/html/2510.27418)
- **Sleep-time compute** (arXiv:2504.13171) and **Generative Agents** (arXiv:2304.03442) — both already
  cited by OpenClaw's own dreaming docs as the design basis for memory-core. Good news: sharpwave-core's
  in-process sleep system and memory-core's dreaming sweep are pulling from the *same* research lineage,
  they just never got introduced to each other. That's an argument for cooperation over replacement.

## 5. Concrete proposals, ranked by leverage / cost

Each item says exactly what changes, where, and why — no code written yet, this is the plan to review
before touching `src/index.ts` or `openclaw.json` (per the OpenClaw Config Gate, any actual config/plugin
change needs the exact doc line cited before it's written, separately from this research pass).

### 5.1 Stop duplicating memory-core's context injection (cheap, immediate)

Have openwave's `before_prompt_build`/`agent_turn_prepare` handlers (`src/index.ts:726,767`) detect
whether `memory-core` currently owns `plugins.slots.memory` (or just check for a non-trivial
`MEMORY.md`/`USER.md` in the workspace) and, if so, **stop re-injecting identity/profile facts that
`MEMORY.md`/`USER.md` bootstrap already covers**, narrowing openwave's own injection to what it uniquely
adds: emotionally-weighted + spreading-activation recall, and cross-session episodic graph traversal.
Saves prompt budget every single turn, removes a source of the two stores silently disagreeing.

### 5.2 REM-phase habituation pass (neuroscience-grounded, moderate)

Add an explicit habituation step to openwave's REM-equivalent sleep phase: for nodes reactivated during
that sweep (touched by `brain_expand`/recall since the last sleep cycle), pull `emotional_weight`
magnitude toward baseline by a fixed fraction — separate from, and in addition to, the existing
time-based 10%/cycle decay at `dist/index.js:3142`. This is the direct analogue of REM-TMR's
"reactivation reduces subjective arousal" finding — it should specifically hit *recently-touched* nodes,
not decay everything uniformly. Pair with a NREM/deep-phase pass that does the opposite for
newly-consolidated *structural* associations (strengthen edges/retrievability, leave emotional_weight
alone) — matching the SWS-integrates / REM-habituates division of labor the 2025 Comms Biology paper
found.

### 5.3 Split emotional_weight into valence + arousal (schema change, moderate)

Replace the single `-1.0..1.0 emotional_weight` scalar with two fields (or keep `emotional_weight` as
signed valence and add `arousal: 0.0..1.0`). Update the salience formula to weight arousal for
consolidation strength (matches the amygdala-arousal literature) while keeping valence available as a
retrieval-bias signal for mood-congruent queries. Migration is additive — existing rows can backfill
`arousal = abs(emotional_weight)` and keep current behavior until re-tuned.

### 5.4 Provenance gate on emotional_weight and salience (security-hardening, adopt from memory-core)

Borrow memory-core's origin-class model directly: tag inbound content processed through openwave's
`message_received` hook with the same `owner`/`agent`/`untrusted`/`system` classification memory-core
uses (ideally by reading the *same* classification if OpenClaw exposes it on the hook context, otherwise
reimplementing the same conservative default — unknown-external defaults to `untrusted`, scaffolding
defaults to `system`, never defaults to `owner`). Structurally block `untrusted`/`system`-origin content
from moving `emotional_weight`/salience in ways that increase auto-injection likelihood, the same way
memory-core excludes those origins from the consolidation prompt entirely. This closes the gap in §1
where emotionally-loaded external content could currently out-compete ordinary content for prompt real
estate with no trust check.

### 5.5 Multi-hop Personalized-PageRank spreading activation (HippoRAG-style, higher effort, highest payoff)

Replace or augment the fixed `spreadingActivationHops: 1` expansion in `brain_expand`/recall with a
PageRank-style walk over the existing edges table, seeded at query-matched nodes, bounded by
`activationThreshold`/`inhibitionStrength` (both already configurable). No new storage; reuses
`brain_link`/`brain_edges`. This is the change HippoRAG's benchmark most directly validates (up to 20%
multi-hop QA gains, 10-30x cheaper than iterative retrieval) and it plugs into infrastructure that
already exists.

### 5.6 Read memory-core as a corpus, never as a write target (integration boundary, cheap)

Formalize what §1 already implies: openwave's extraction pipeline (`llm_output`/`after_compaction`
hooks) can read `MEMORY.md`/`DREAMS.md`/daily notes as **additional source material** for its own graph
(tagging derived nodes with `source: "memory-core:MEMORY.md#Lx-Ly"`, which the schema already supports),
piggybacking on memory-core's already-provenance-gated curation instead of re-deriving trust from raw
daily notes. It should never write back into those files — let memory-core's single-writer/optimistic-
concurrency design stay intact (§1).

### 5.7 Register openwave's sleep cadence against the shared background-work budget

Either move openwave's sleep-phase scheduling onto OpenClaw's documented cron system (so it's visible to
`openclaw cron list` and can be staggered against memory-core's `0 3 * * *` default) or, at minimum,
explicitly offset it. Directly forestalls the class of incident already logged in
`reference_openclaw_2026_8_upgrade_recovery.md` (heartbeat/cron phase-collisions causing WAL/event-loop
freezes) recurring as two independent nightly LLM sweeps per agent instead of one.

## Related project memory

- [[project-sharpwave]] — distribution status, the rebrand history (clawbrain-mcp → sharpwave-core engine
  → openwave for OpenClaw / sharpwave for MCP).
- [[project-clawbrain-mcp-angle]] — MCP-as-distribution angle; this integration work is orthogonal (it's
  about the OpenClaw-native plugin cooperating with OpenClaw's own shipped memory, not the MCP surface).
- [[feedback-clawbrain-superbrain-philosophy]] — "tweak biology to advantage, always"; §5.2/5.3/5.5 are
  exactly that pattern (adopt what the wetware does well, don't stop at reproducing it).
