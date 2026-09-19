# Engram first-graft — Hailey summary

## PRs
- sharpwave: https://github.com/Enlightened-Republic/sharpwave/pull/5
- openwave: https://github.com/Enlightened-Republic/openwave/pull/1

## Before merge (openwave)
```bash
git apply patches/engram-graft-ab-index.patch
```
(MCP could not push the full 54KB `src/index.ts`; apply the patch after checkout. Local vitest 26/26 with patch applied.)

## Do **not** enable openwave on any gateway.

## Tests
- sharpwave-core context-assembly: 18/18
- openwave (full local tree): 26/26

## Graft B smoke (needs live gateway)
Confirm `openwave:consolidation` appears in `openclaw cron list`, fires near 04:30, and `cron_changed` triggers in-process `runConsolidationPass`.
