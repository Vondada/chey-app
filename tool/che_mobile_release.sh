#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODE="${1:-auto}"
case "$MODE" in
  auto|full|fast) ;;
  *) echo "Usage: $0 [auto|full|fast]" >&2; exit 2 ;;
esac

PUBSPEC_VERSION="$(python3 - <<'PY'
from pathlib import Path
import re
m = re.search(r'^version:\s*([^+\s]+)\+([0-9]+)\s*$', Path('pubspec.yaml').read_text(), re.M)
if not m:
    raise SystemExit('pubspec.yaml needs version: X.Y.Z+N')
print(m.group(1), m.group(2))
PY
)"
VERSION="${PUBSPEC_VERSION% *}"
BASE_BUILD="${PUBSPEC_VERSION#* }"
COMMIT="${CM_COMMIT:-${GIT_COMMIT:-$(git rev-parse HEAD)}}"
CM_SEQ="${BUILD_NUMBER:-${CM_BUILD_NUMBER:-0}}"
if ! [[ "$CM_SEQ" =~ ^[0-9]+$ ]]; then CM_SEQ=0; fi
# Keep every full cloud build monotonically distinct from the checked-in build.
FULL_BUILD=$((BASE_BUILD * 100000 + CM_SEQ))
if (( CM_SEQ == 0 )); then FULL_BUILD=$((BASE_BUILD * 100000 + 1)); fi
AGENT_URL="${CHE_AGENT_URL:-https://chey-app.henryjavoni.workers.dev}"
IPA="build/ios/ipa/CHE-unsigned.ipa"
META="build/ios/ipa/CHE-update.json"

changed_files() {
  if git rev-parse HEAD^ >/dev/null 2>&1; then
    git diff --name-only HEAD^ HEAD
  else
    git ls-files
  fi
}

choose_lane() {
  if [[ "$MODE" == "full" || "$MODE" == "fast" ]]; then
    echo "$MODE"
    return
  fi
  local mobile=0 full=0 path
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    case "$path" in
      server/*|docs/*|*.md|.github/*|test/*) ;;
      lib/*) mobile=1 ;;
      ios/*|assets/*|pubspec.yaml|pubspec.lock|shorebird.yaml|codemagic.yaml|tool/bootstrap.sh|tool/patch_local_runtime.py)
        mobile=1; full=1 ;;
      *)
        # Unknown build-affecting changes are conservative: a full IPA is safer
        # than silently assuming Shorebird can carry them.
        mobile=1; full=1 ;;
    esac
  done < <(changed_files)
  if (( mobile == 0 )); then echo none
  elif (( full == 1 )); then echo full
  else echo fast
  fi
}

install_shorebird() {
  export PATH="$HOME/.shorebird/bin:$PATH"
  if command -v shorebird >/dev/null 2>&1; then return 0; fi
  curl --proto '=https' --tlsv1.2     https://raw.githubusercontent.com/shorebirdtech/install/main/install.sh -sSf | bash
  export PATH="$HOME/.shorebird/bin:$PATH"
  command -v shorebird >/dev/null 2>&1
}

dart_defines=(
  "--dart-define=CHE_AGENT_URL=$AGENT_URL"
  "--dart-define=CHE_APP_VERSION=$VERSION"
  "--dart-define=CHE_BUILD_NUMBER=$FULL_BUILD"
  "--dart-define=CHE_BUILD_COMMIT=$COMMIT"
)

package_ipa() {
  mkdir -p build/ios/ipa
  local generated
  generated="$(find build/ios/ipa -maxdepth 1 -type f -name '*.ipa' ! -name 'CHE-unsigned.ipa' -print -quit)"
  if [[ -n "$generated" && -s "$generated" ]]; then
    cp "$generated" "$IPA"
  else
    test -d build/ios/iphoneos/Runner.app
    rm -rf build/ios/ipa/Payload
    mkdir -p build/ios/ipa/Payload
    cp -R build/ios/iphoneos/Runner.app build/ios/ipa/Payload/
    (
      cd build/ios/ipa
      rm -f CHE-unsigned.ipa
      zip -qry CHE-unsigned.ipa Payload
      rm -rf Payload
    )
  fi
  test -s "$IPA"
}

build_full() {
  local shorebird_base=false
  rm -rf build/ios/ipa
  if [[ -n "${SHOREBIRD_TOKEN:-}" && -f shorebird.yaml ]] && install_shorebird; then
    echo "Creating Shorebird iOS release baseline..."
    if shorebird release ios --no-codesign --build-name="$VERSION" --build-number="$FULL_BUILD" -- "${dart_defines[@]}"; then
      shorebird_base=true
    else
      echo "Shorebird release failed; building a normal unsigned IPA instead." >&2
      flutter build ios --release --no-codesign         "--build-name=$VERSION" "--build-number=$FULL_BUILD" "${dart_defines[@]}"
    fi
  else
    echo "Shorebird is not configured; building a normal unsigned IPA."
    flutter build ios --release --no-codesign       "--build-name=$VERSION" "--build-number=$FULL_BUILD" "${dart_defines[@]}"
  fi
  package_ipa
  publish_release "$shorebird_base"
}

latest_verified_release() {
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-${CM_GITHUB_TOKEN:-}}}"
  local headers=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
  if [[ -n "$token" ]]; then
    headers+=(-H "Authorization: Bearer $token")
  fi
  curl -fsS "${headers[@]}"     "https://api.github.com/repos/Vondada/chey-app/releases?per_page=30" |
    python3 -c '
import json, re, sys
for release in json.load(sys.stdin):
    if release.get("draft") or release.get("prerelease"):
        continue
    match = re.fullmatch(r"che-ios-v(.+)-b([0-9]+)", str(release.get("tag_name", "")))
    if not match:
        continue
    if not any(a.get("name") == "CHE-unsigned.ipa" and a.get("state") != "deleted" for a in release.get("assets", [])):
        continue
    shorebird = bool(re.search(r"(?m)^shorebird_base=true\\s*$", str(release.get("body", ""))))
    print(match.group(1), match.group(2), "true" if shorebird else "false")
    break
'
}

build_fast() {
  if [[ -z "${SHOREBIRD_TOKEN:-}" || ! -f shorebird.yaml ]] || ! install_shorebird; then
    echo "Fast lane unavailable; falling back to a full IPA."
    build_full
    return
  fi
  # Target the exact version+build installed from the last verified IPA.
  # Shorebird patches only apply when the release and patch versions match.
  local verified release_version release_build shorebird_base
  verified="$(latest_verified_release || true)"
  if [[ -z "$verified" ]]; then
    echo "No verified CHE IPA base exists yet; creating the first full release."
    build_full
    return
  fi
  read -r release_version release_build shorebird_base <<<"$verified"
  if [[ "$shorebird_base" != "true" ]]; then
    echo "The latest verified IPA is not a Shorebird release base; creating a new full base."
    build_full
    return
  fi
  echo "Attempting Shorebird fast update for ${release_version}+${release_build}..."
  if shorebird patch ios --no-codesign       --release-version="${release_version}+${release_build}" --       "--build-name=${release_version}"       "--build-number=${release_build}"       "--dart-define=CHE_AGENT_URL=$AGENT_URL"       "--dart-define=CHE_APP_VERSION=${release_version}"       "--dart-define=CHE_BUILD_NUMBER=${release_build}"       "--dart-define=CHE_BUILD_COMMIT=$COMMIT"; then
    echo "CHE fast update published through Shorebird; no new IPA is required."
    return
  fi
  echo "Fast update could not be safely produced; falling back to a full IPA." >&2
  build_full
}

publish_release() {
  local shorebird_base="$1"
  local token="${GITHUB_TOKEN:-${GH_TOKEN:-${CM_GITHUB_TOKEN:-}}}"
  local sha size tag notes escaped_json release_json release_id upload_url
  sha="$(shasum -a 256 "$IPA" | awk '{print $1}')"
  size="$(stat -f%z "$IPA" 2>/dev/null || stat -c%s "$IPA")"
  tag="che-ios-v${VERSION}-b${FULL_BUILD}"
  notes="$(git log -1 --pretty=%B | head -c 3000)"
  mkdir -p "$(dirname "$META")"

  python3 - "$META" "$VERSION" "$FULL_BUILD" "$COMMIT" "$sha" "$size" "$shorebird_base" "$tag" <<'PY'
import json, sys
path, version, build, commit, sha, size, shorebird, tag = sys.argv[1:]
with open(path, 'w') as f:
    json.dump({
        "version": version,
        "build_number": build,
        "commit_sha": commit,
        "sha256": sha,
        "size": int(size),
        "shorebird_base": shorebird == "true",
        "update_lane": "full",
        "build_status": "success",
        "tag": tag,
    }, f, indent=2)
PY

  if [[ -z "$token" ]]; then
    echo "No GitHub release token is configured. The IPA remains a Codemagic artifact, but CHE's mobile update endpoint will NOT advertise it." >&2
    echo "Add GITHUB_TOKEN as a protected secret in the Codemagic che_ship group to enable phone-only publishing." >&2
    return 1
  fi

  release_json="$(mktemp)"
  python3 - "$release_json" "$tag" "$COMMIT" "$VERSION" "$FULL_BUILD" "$sha" "$size" "$shorebird_base" "$notes" <<'PY'
import json, sys
path, tag, commit, version, build, sha, size, shorebird, notes = sys.argv[1:]
body = (notes.strip() or f"CHE iPhone build {version} ({build}).") + "\n\n" + """<!-- CHE-META
version={version}
build={build}
commit={commit}
sha256={sha}
size={size}
shorebird_base={shorebird}
-->""".format(
    version=version, build=build, commit=commit, sha=sha, size=size,
    shorebird=shorebird,
)
with open(path, 'w') as f:
    json.dump({
        "tag_name": tag,
        "target_commitish": commit,
        "name": f"CHE iPhone {version} ({build})",
        "body": body,
        "draft": True,
        "prerelease": False,
    }, f)
PY

  echo "Publishing verified IPA to GitHub Releases..."
  created="$(curl -fsS -X POST -H "Accept: application/vnd.github+json" -H "Authorization: Bearer $token" -H "X-GitHub-Api-Version: 2022-11-28" -H "Content-Type: application/json" "https://api.github.com/repos/Vondada/chey-app/releases" --data-binary "@$release_json")"
  release_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$created")"
  upload_url="https://uploads.github.com/repos/Vondada/chey-app/releases/${release_id}/assets"

  uploaded_ipa="$(curl -fsS -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/octet-stream" --data-binary "@$IPA" "$upload_url?name=CHE-unsigned.ipa")"
  remote_digest="$(python3 -c 'import json,sys; print((json.load(sys.stdin).get("digest") or "").removeprefix("sha256:"))' <<<"$uploaded_ipa")"
  if [[ -z "$remote_digest" || "$remote_digest" != "$sha" ]]; then
    echo "Uploaded IPA digest did not match local SHA-256; keeping it unavailable." >&2
    curl -fsS -X DELETE -H "Authorization: Bearer $token" -H "X-GitHub-Api-Version: 2022-11-28" "https://api.github.com/repos/Vondada/chey-app/releases/$release_id" >/dev/null || true
    exit 1
  fi

  curl -fsS -X POST -H "Authorization: Bearer $token" -H "Content-Type: application/json" --data-binary "@$META" "$upload_url?name=CHE-update.json" >/dev/null

  # The Worker ignores drafts. Make this build visible only after digest verification.
  curl -fsS -X PATCH -H "Accept: application/vnd.github+json" -H "Authorization: Bearer $token" -H "X-GitHub-Api-Version: 2022-11-28" -H "Content-Type: application/json" "https://api.github.com/repos/Vondada/chey-app/releases/$release_id" --data-binary '{"draft":false}' >/dev/null

  echo "Published $tag with verified SHA-256 $sha."
}

LANE="$(choose_lane)"
echo "CHE mobile update lane: $LANE"
case "$LANE" in
  none)
    echo "No iPhone code changed; no mobile build is needed."
    ;;
  fast)
    build_fast
    ;;
  full)
    build_full
    ;;
esac
