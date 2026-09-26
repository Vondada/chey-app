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
    --project-name chey_app \
    --platforms "$platforms" \
    .
fi

flutter pub get
