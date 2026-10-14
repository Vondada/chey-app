#!/usr/bin/env bash
# Runs the checks CI runs (.github/workflows/flutter-check.yml) for the paths
# changed since a base ref, and prints only failures plus one line per check.
#   bash .claude/skills/che-debug/scripts/run_checks.sh [base-ref|--all]
set -uo pipefail
root="$(git rev-parse --show-toplevel)" || exit 2
cd "$root" || exit 2
here="$root/.claude/skills/che-debug/scripts"
base="${1:-origin/main}"
if [ "$base" = "--all" ]; then
  changed="server/cloudflare/ lib/ tools/ .claude/skills/ .github/workflows/"
else
  changed="$( { git diff --name-only "$base"...HEAD 2>/dev/null; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)"
fi
has() { printf '%s\n' "$changed" | grep -Eq "$1"; }
status=0
summary=()
note() { summary+=("$1"); }

if has '^server/cloudflare/'; then
  bad=""
  for f in server/cloudflare/*.js; do node --check "$f" 2>/dev/null || bad="$bad $f"; done
  if [ -n "$bad" ]; then note "worker syntax: FAIL$bad"; status=1; else note "worker syntax: PASS"; fi
  out="$(node --test --test-reporter=tap server/cloudflare/*.test.mjs 2>&1)"
  res="$(printf '%s' "$out" | node "$here/summarize_tap.mjs")" || status=1
  printf '%s\n' "$res" | sed '$d'
  note "worker tests: $(printf '%s\n' "$res" | tail -1)"
fi

if has '^\.claude/skills/'; then
  out="$(node --test --test-reporter=tap .claude/skills/tests/*.test.mjs 2>&1)"
  res="$(printf '%s' "$out" | node "$here/summarize_tap.mjs")" || status=1
  printf '%s\n' "$res" | sed '$d'
  note "skills tests: $(printf '%s\n' "$res" | tail -1)"
fi

if has '^(lib|test)/|^pubspec\.yaml|^analysis_options\.yaml'; then
  if command -v dart >/dev/null && command -v flutter >/dev/null; then
    if out="$(dart analyze --fatal-infos lib test 2>&1)"; then note "dart analyze: PASS"; else printf '%s\n' "$out" | grep -E '^\s*(error|warning|info) ' | head -30; note "dart analyze: FAIL"; status=1; fi
    if out="$(flutter test 2>&1)"; then note "flutter test: PASS ($(printf '%s' "$out" | grep -Eo '\+[0-9]+' | tail -1))"; else printf '%s\n' "$out" | grep -E 'FAILED|Expected|Actual|Error' | head -40; note "flutter test: FAIL"; status=1; fi
    git checkout -q -- analysis_options.yaml 2>/dev/null || true
  else
    note "flutter: NOT RUN here (no flutter/dart on PATH); CI runs it, so do not call it verified"
  fi
fi

if has '^tools/'; then
  if out="$(python3 -m unittest discover -s tools -p 'test_che_video_render.py' 2>&1)"; then note "tools tests: PASS"; else printf '%s\n' "$out" | tail -20; note "tools tests: FAIL"; status=1; fi
fi

if has '^\.github/workflows/'; then
  if out="$(python3 "$here/check_workflows.py" .github/workflows/*.yml 2>&1)"; then note "workflows: PASS ($out)"; else printf '%s\n' "$out"; note "workflows: FAIL"; status=1; fi
fi

[ ${#summary[@]} -eq 0 ] && note "nothing to check: no changed paths that CI tests (base $base)"
printf '%s\n' "${summary[@]}"
exit $status
