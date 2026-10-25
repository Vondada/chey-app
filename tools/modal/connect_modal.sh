#!/usr/bin/env bash
# Deploys CHE's Modal app and connects the Worker to it. Run by .github/workflows/che-modal-deploy.yml.
# Every failure exits non-zero with its real reason and never reaches the "connected" line. The Worker secret
# MODAL_TOKEN is written only after the deployed app has answered an authenticated /health for che-gpu.
# Secret values never reach the log: every message passes through redact(), and tokens are only validated by format.
set -euo pipefail

MODAL=${MODAL_CMD:-modal}
CURL=${CURL_CMD:-curl}
WRANGLER=${WRANGLER_CMD:-npx --yes wrangler@4}
APP_DIR=${APP_DIR:-$(cd "$(dirname "$0")" && pwd)}
WORKER_DIR=${WORKER_DIR:-$APP_DIR/../../server/cloudflare}
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/null}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Replaces every secret value, and any bearer:<token> string, with ***. Reads stdin, writes stdout.
redact() {
  python3 -c '
import os, re, sys
text = sys.stdin.read()
for name in ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "CLOUDFLARE_API_TOKEN", "CHE_GPU_ACCESS_TOKEN"):
    value = os.environ.get(name, "")
    if len(value) >= 8:
        text = text.replace(value, "***")
text = re.sub(r"bearer:[^@\s]+", "bearer:***", text)
sys.stdout.write(text)'
}

# A failure: say why, in the log and in the step summary, then stop. The summary never says "connected" here.
fail() {
  echo "::error::$1" >&2
  {
    echo "### CHE Modal NOT connected"
    echo "- $1"
    echo "- Nothing was written to the Worker. Fix the reason above and run this workflow again."
  } >> "$SUMMARY"
  exit 1
}

# The last lines of a log, redacted, as a fenced block for the summary and the error text.
tail_of() {
  echo '```'
  redact < "$1" | tail -n "${2:-30}"
  echo '```'
}

# 1. The secrets must exist and look like Modal tokens. Only the names and the format are checked, never the values.
missing=""
for name in MODAL_TOKEN_ID MODAL_TOKEN_SECRET CLOUDFLARE_API_TOKEN; do
  [ -n "${!name:-}" ] || missing="$missing $name"
done
[ -z "$missing" ] || fail "Missing GitHub Actions repository secrets:$missing. Add them under Settings > Secrets and variables > Actions. Cloudflare Worker secrets cannot be reused: GitHub cannot read them."
[[ "$MODAL_TOKEN_ID" =~ ^ak-[A-Za-z0-9]{6,}$ ]] || fail "MODAL_TOKEN_ID is not in Modal's token-ID format (it starts with ak-). Copy the token ID again from Modal's settings."
[[ "$MODAL_TOKEN_SECRET" =~ ^as-[A-Za-z0-9]{6,}$ ]] || fail "MODAL_TOKEN_SECRET is not in Modal's token-secret format (it starts with as-). Copy the token secret again from Modal's settings."
echo "Secrets present and in Modal's format (values hidden)."

# 2. A fresh 256-bit access token for this deploy only. It is masked in GitHub's log.
tok=$(openssl rand -hex 32)
export CHE_GPU_ACCESS_TOKEN="$tok"
if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$tok"; fi

# 3. Store it as the Modal secret that the app reads.
if ! $MODAL secret create che-gpu-auth "CHE_GPU_ENDPOINT_TOKEN=$tok" --force > "$WORK/secret.log" 2>&1; then
  fail "modal secret create che-gpu-auth failed: $(redact < "$WORK/secret.log" | tail -n 5 | tr '\n' ' ')"
fi

# 4. Deploy. The full log is kept; on failure its last lines are shown, redacted, with the real Modal error.
if ! (cd "$APP_DIR" && $MODAL deploy che_modal_app.py) > "$WORK/deploy.log" 2>&1; then
  {
    echo "### CHE Modal NOT connected"
    echo "- modal deploy failed. Last lines of its output (secrets hidden):"
    tail_of "$WORK/deploy.log" 40
  } >> "$SUMMARY"
  echo "::error::modal deploy failed. Last lines (secrets hidden):" >&2
  redact < "$WORK/deploy.log" | tail -n 40 >&2
  exit 1
fi
echo "modal deploy finished."

url=$(grep -o -E 'https://[A-Za-z0-9-]+--che-gpu[A-Za-z0-9-]*\.modal\.run' "$WORK/deploy.log" | head -n 1 || true)
[ -n "$url" ] || fail "modal deploy finished, but no che-gpu endpoint URL was in its output. Check the deploy log for the app name."
echo "Endpoint: $url"

# 5. Unauthenticated must be refused; the authenticated /health must answer the expected app and version.
anon=$($CURL -s -o /dev/null -w '%{http_code}' --max-time 120 "$url/health" || true)
echo "Unauthenticated /health: HTTP $anon"
[ "$anon" = "401" ] || fail "the endpoint did not refuse an unauthenticated request (HTTP $anon, expected 401). Nothing was connected."

if ! health=$($CURL -sf --max-time 120 -H "Authorization: Bearer $tok" "$url/health" 2> "$WORK/health.err"); then
  fail "authenticated /health failed: $(redact < "$WORK/health.err" | tail -n 3 | tr '\n' ' ')"
fi
if ! echo "$health" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("app")=="che-gpu" and d.get("version")' 2> /dev/null; then
  fail "the endpoint answered /health, but not as the che-gpu app: $(echo "$health" | head -c 200)"
fi
echo "Authenticated /health: $health"

# 6. Connect the Worker. The value goes in on stdin, never in argv or the log.
if ! printf '%s' "bearer:${tok}@${url}" | (cd "$WORKER_DIR" && $WRANGLER secret put MODAL_TOKEN) > "$WORK/wrangler.log" 2>&1; then
  fail "could not write the Worker secret MODAL_TOKEN: $(redact < "$WORK/wrangler.log" | tail -n 5 | tr '\n' ' ')"
fi

# 7. Only now is it connected. Say so, with the receipts.
{
  echo "### CHE Modal app deployed and connected"
  echo "- Endpoint: \`$url\`"
  echo "- Unauthenticated request refused: HTTP $anon"
  echo "- Authenticated /health: \`$health\`"
  echo "- Worker secret MODAL_TOKEN written (value never printed)."
  echo "- Next: say \"CHE, connect Modal\"; she verifies the same /health before saying Connected."
} >> "$SUMMARY"
echo "CONNECTED: Modal app deployed, verified, and the Worker secret written."
