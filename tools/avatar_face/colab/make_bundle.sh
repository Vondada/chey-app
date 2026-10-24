#!/bin/bash
# Pack what a Colab face test needs into one zip for My Drive/CHE_face: the face tools, the strand-hair builder, CHE's
# scene (textures packed), the fitted identity, her landmarks, the realism reference and the saved progress files.
#   bash colab/make_bundle.sh OUT.zip CHE.blend FIT.json LANDMARKS.npz REFERENCE.png [EXTRA.blend ...]
# Nothing is rebuilt: the .blend files are copied as they are.
set -euo pipefail
out=$(realpath -m "$1"); che=$2; fit=$3; lm=$4; ref=$5; shift 5
here=$(cd "$(dirname "$0")/../.." && pwd)   # tools/
tmp=$(mktemp -d)
mkdir -p "$tmp/tools" "$tmp/project/reference" "$tmp/project/progress"
cp -r "$here/avatar_face" "$here/avatar_portraits" "$tmp/tools/"
find "$tmp/tools" -name __pycache__ -prune -exec rm -r {} +
cp "$che" "$tmp/project/che.blend"
cp "$fit" "$tmp/project/fit.json"
cp "$lm" "$tmp/project/che_landmarks.npz"
cp "$ref" "$tmp/project/reference/$(basename "$ref")"
for f in "$@"; do cp "$f" "$tmp/project/progress/"; done
(cd "$tmp" && find . -type f -exec sha256sum {} + | sort -k2 > "$tmp.sha256" && mv "$tmp.sha256" MANIFEST.sha256 && zip -qr "$out" .)
echo "BUNDLE $out $(du -h "$out" | cut -f1)"; cat "$tmp/MANIFEST.sha256"
