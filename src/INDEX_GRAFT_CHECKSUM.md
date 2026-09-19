# Grafted index.ts checksum

Expected after applying `patches/engram-graft-ab-index.patch` onto this branch's pre-patch `src/index.ts`:

- md5: `7c708493cfa8cc131ee762653b51372d`
- size: 54721 bytes
- must contain: `assemblyOptsFor`, `ensureConsolidationCron`, `curatedTierDedupe`

Apply:
```bash
git apply patches/engram-graft-ab-index.patch
```
