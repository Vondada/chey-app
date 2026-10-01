#!/usr/bin/env bash
set -euo pipefail

TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-${CM_GITHUB_TOKEN:-}}}"
[[ -z "$TOKEN" ]] && { echo "No GitHub token; mobile build status cannot be reported."; exit 0; }

COMMIT="${CM_COMMIT:-$(git rev-parse HEAD)}"
if [[ -f "$HOME/CHE_MOBILE_SUCCESS" ]]; then
  STATE=success
  DESCRIPTION="CHE mobile update pipeline completed."
else
  STATE=failure
  DESCRIPTION="CHE mobile build failed; previous verified IPA remains available."
fi

payload="$(python3 - "$STATE" "$DESCRIPTION" <<'PY'
import json, sys
print(json.dumps({
    "state": sys.argv[1],
    "context": "CHE iPhone update",
    "description": sys.argv[2],
}))
PY
)"

curl -fsS -X POST   -H "Accept: application/vnd.github+json"   -H "Authorization: Bearer $TOKEN"   -H "X-GitHub-Api-Version: 2022-11-28"   -H "Content-Type: application/json"   "https://api.github.com/repos/Vondada/chey-app/statuses/$COMMIT"   --data-binary "$payload" >/dev/null

echo "Reported CHE iPhone update status: $STATE"
