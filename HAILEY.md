# Engram first-graft — Hailey summary

## PRs
- **sharpwave:** https://github.com/Enlightened-Republic/sharpwave/pull/5
- **openwave:** https://github.com/Enlightened-Republic/openwave/pull/1

## Do **not** enable openwave on any gateway.

## Before merge (openwave) — required one-liner
MCP Contents API cannot reliably push the full 54KB `src/index.ts`. Wiring lives in a verified patch:

```bash
bash scripts/apply-engram-index-graft.sh
# or: git apply patches/engram-graft-ab-index.patch
npm test   # expect 26/26 with file:../sharpwave/packages/core or published 0.4.2
```

Patch includes: `assemblyOptsFor` on bootstrap/self-model/heartbeat; `ensureConsolidationCron` on `gateway_start`; `cron_changed` → `runConsolidationPass`; `curatedTierDedupe` defaults; legacy cron cleanup never deletes `openwave:consolidation`.

## Already on the branch (no apply needed)
- `src/engram-graft.ts` — detection → `{ externalMemoryActive }`, cron register/fire helpers
- `src/scheduler.ts` — Graft B: replay+embedding only; exported `runConsolidationPass`
- Config schema: `curatedTierDedupe`, `consolidationCron` (`30 4 * * *`), `consolidationCronEnabled`
- Tests: scheduler / lifecycle / consolidation-cron
- `sharpwave-core` pin `^0.4.2` (needs sharpwave#5 publish)

## Tests (box, PT)
- sharpwave-core `context-assembly`: **18/18**
- openwave full local tree (index grafted): **26/26**

## Graft B smoke (live gateway — Hailey)
1. Confirm `openwave:consolidation` in `openclaw cron list` at `30 4 * * *`
2. Confirm still registered when dreaming disabled
3. Fire / wait → `cron_changed` triggers in-process consolidation (best-effort; verify action/status strings)

## Constraints honored
- No `kind:memory`
- Never write MEMORY.md / USER.md / DREAMS.md
- openwave not enabled on any gateway
