# Engram first-graft — Hailey summary

## PRs
- **sharpwave:** https://github.com/Enlightened-Republic/sharpwave/pull/5 (widened `externalMemoryActive`)
- **openwave:** https://github.com/Enlightened-Republic/openwave/pull/1

## Do **not** enable openwave on any gateway.

## What's in openwave#1 (rebased onto main c290b58)
- `src/engram-graft.ts` — `assemblyOptsFor` (Graft A: host MEMORY.md/USER.md → `externalMemoryActive`, opt-out via `curatedTierDedupe: false`), `ensureConsolidationCron` / `maybeRunConsolidationFromCronEvent` (Graft B).
- `src/index.ts` — main's `contextOptsFor` now routes through `assemblyOptsFor`; `gateway_start` registers host cron `openwave:consolidation` (`30 4 * * *`, still registered when dreaming is disabled); `cron_changed` for that job runs `runConsolidationPass` in-process; legacy cleanup never deletes `openwave:consolidation`.
- `src/scheduler.ts` — in-process timers: awake-replay 30m, **extraction harvest 60m**, embedding sweep 10m. No in-process LLM consolidation; `runConsolidationPass` (harvest → gate → consolidate) is host-cron driven.
- Config schema: `curatedTierDedupe`, `consolidationCron`, `consolidationCronEnabled`.

## Dependency
- `sharpwave-core` pinned `^0.4.4`. Published 0.4.3 does **not** contain sharpwave#5's widening (0.4.2/0.4.3 only suppress the goals block). sharpwave#5 must be rebased onto sharpwave main and published as 0.4.4 (its own 0.4.2 bump collides with the already-published 0.4.2). `package-lock.json` still resolves 0.4.3 until 0.4.4 is published — run `npm install` then to refresh it.
- openwave works against 0.4.3 too (tests pass); the widened dedupe simply isn't active until 0.4.4.

## Graft B smoke (live gateway — Hailey)
1. Confirm `openwave:consolidation` in `openclaw cron list` at `30 4 * * *`
2. Confirm still registered when dreaming disabled
3. Fire / wait → `cron_changed` triggers in-process consolidation (best-effort; verify the action/status strings the host actually emits)
4. Confirm `extraction.tick` appears hourly in the gateway log

## Constraints honored
- No `kind:memory`
- Never write MEMORY.md / USER.md / DREAMS.md
- openwave not enabled on any gateway
