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
- `sharpwave-core` pinned `^0.4.5` (published on npm as `latest`; contains sharpwave#5's widened `externalMemoryActive`). `package-lock.json` resolves 0.4.5, so a plain `npm ci` works. The old workaround (build core from the sharpwave checkout and `npm install --no-save ..\sharpwave\packages\core`, never `npm ci`) is no longer needed; see sharpwave `docs/windows-install-runbook.md` §10g.2 for the updated install.

## Graft B smoke (live gateway — Hailey)
1. Confirm `openwave:consolidation` in `openclaw cron list` at `30 4 * * *`
2. Confirm still registered when dreaming disabled
3. Fire / wait → `cron_changed` triggers in-process consolidation (best-effort; verify the action/status strings the host actually emits)
4. Confirm `extraction.tick` appears hourly in the gateway log

## Constraints honored
- No `kind:memory`
- Never write MEMORY.md / USER.md / DREAMS.md
- openwave not enabled on any gateway
