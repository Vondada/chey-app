#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter is required. Install the stable Flutter SDK first." >&2
  exit 1
fi

missing_platforms=()
[[ -d android ]] || missing_platforms+=(android)
[[ -d ios ]] || missing_platforms+=(ios)

if ((${#missing_platforms[@]} > 0)); then
  platforms=$(IFS=,; echo "${missing_platforms[*]}")
  flutter create \
    --org com.cheyapp \
    --project-name chey \
    --platforms "$platforms" \
    .
fi
rm -f test/widget_test.dart

flutter pub get

# Flutter generates ios/ on CI; the permissions must be in the generated
# Info.plist before the iPhone build asks for microphone/speech access.
if [[ -f ios/Runner/Info.plist ]]; then
  python3 - <<'PY'
import plistlib
from pathlib import Path

path = Path('ios/Runner/Info.plist')
with path.open('rb') as stream:
    info = plistlib.load(stream)
info['NSMicrophoneUsageDescription'] = 'CHE uses your microphone when you speak to your assistant or capture audio.'
info['NSSpeechRecognitionUsageDescription'] = 'CHE converts your speech to text when you use voice chat.'
info['NSCameraUsageDescription'] = 'CHE uses the camera only when you choose to capture a photo or video for Chay to analyze.'
info['NSPhotoLibraryUsageDescription'] = 'CHE accesses selected photos or videos only when you choose them for Chay to analyze.'
with path.open('wb') as stream:
    plistlib.dump(info, stream)
PY
fi
