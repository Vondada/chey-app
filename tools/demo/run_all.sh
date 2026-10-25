#!/bin/bash
# Rebuilds the Create Room demo video end to end (docs/CHE_CREATE_ROOM_DEMO.md).
#   tools/demo/run_all.sh WORK_DIR BLENDER PROJECT_DIR
# WORK_DIR gets models/, build/ and out/; BLENDER is Blender 5.0.x (or a wrapper over the pip bpy module); PROJECT_DIR
# holds che.blend and fit.json (as the CPU worker has them). Needs: MPFB (MPFB2 data dir), ffmpeg, node + playwright,
# and a Python venv with sherpa-onnx==1.13.8 at $TTS_PY plus the Kokoro int8 en v0.19 model at $KOKORO
# (https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-en-v0_19.tar.bz2, the file the app uses).
set -euo pipefail
W=$1; B=$2; PROJ=$3
D=$(cd "$(dirname "$0")" && pwd)
: "${MPFB:?set MPFB to the MPFB2 data dir}" "${TTS_PY:?set TTS_PY}" "${KOKORO:?set KOKORO}"
mkdir -p "$W/models" "$W/build" "$W/out"
SECONDS=0
python3 "$D/build_models.py" --blender "$B" --project "$PROJ" --out "$W/models"
python3 "$D/render_closeups.py" --blender "$B" --models "$W/models"
python3 "$D/roblox_receipt.py" --blender "$B" --glb "$W/models/photoreal/model.glb" --out "$W/build"
python3 "$D/inspect_glbs.py" "$W/models" > "$W/build/evidence.json"
"$TTS_PY" "$D/tts.py" --model-dir "$KOKORO" --out "$W/build"
echo "models + speech: ${SECONDS}s"
node "$D/capture.mjs" "$W/build" "$W/models"
python3 "$D/assemble.py" "$W/build" "$W/out"
echo "total: ${SECONDS}s"
