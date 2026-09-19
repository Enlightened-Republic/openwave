#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/patches/engram-graft-ab-index.patch" ]]; then
  if ! grep -q 'assemblyOptsFor' "$ROOT/src/index.ts" 2>/dev/null; then
    git -C "$ROOT" apply patches/engram-graft-ab-index.patch
    echo "Applied patches/engram-graft-ab-index.patch"
  else
    echo "src/index.ts already contains assemblyOptsFor — skip"
  fi
else
  echo "missing patch" >&2
  exit 1
fi
EXPECTED_MD5=7c708493cfa8cc131ee762653b51372d
GOT=$(md5sum "$ROOT/src/index.ts" | awk '{print $1}')
if [[ "$GOT" != "$EXPECTED_MD5" ]]; then
  echo "WARN: md5 $GOT != expected $EXPECTED_MD5 (context drift OK if markers present)" >&2
fi
grep -q assemblyOptsFor "$ROOT/src/index.ts"
grep -q ensureConsolidationCron "$ROOT/src/index.ts"
echo "Graft markers OK"
