#!/usr/bin/env bash
# Downloads the pinned MPFB2 data folder (MakeHuman base mesh, targets, rigs and weights; assets CC0 1.0) that
# build_reference.py reads. Prints the data directory to pass as --data.
set -euo pipefail
REV=b1a2dc98776da9d1eea751b159d42cf61778fe2e
DEST="${1:-$(dirname "$0")/.cache/mpfb2}"
if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$DEST"
  git -C "$DEST" init -q
  git -C "$DEST" remote add origin https://github.com/makehumancommunity/mpfb2
fi
git -C "$DEST" fetch -q --depth 1 origin "$REV"
git -C "$DEST" checkout -q FETCH_HEAD
echo "$DEST/src/mpfb/data"
