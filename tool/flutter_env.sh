#!/usr/bin/env bash
# Pinned Flutter for CHE's build container and local sessions. Installs the SDK once into a cache that
# survives later sessions on the same machine, checks the archive's SHA-256, and prints the PATH line to
# evaluate, so every session spends its time building instead of reinstalling:
#
#   eval "$(tool/flutter_env.sh)"     # then: flutter --version, flutter analyze, flutter test
#
# Reinstalls only when the pinned version changes. Set CHE_TOOLS_DIR to move the cache. Prints nothing else to stdout.
set -eu

FLUTTER_VERSION="3.47.8"
FLUTTER_SHA256="baf7dcc5a3dbba60fe863bf493a6cf203195621f7786eaa5a1bba02cd0d87dd2"
TOOLS_DIR="${CHE_TOOLS_DIR:-$HOME/.cache/che-tools}"
SDK="$TOOLS_DIR/flutter-$FLUTTER_VERSION"
ARCHIVE="flutter_linux_${FLUTTER_VERSION}-stable.tar.xz"
URL="https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/$ARCHIVE"

if [ ! -x "$SDK/bin/flutter" ]; then
  mkdir -p "$TOOLS_DIR"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  echo "Installing Flutter $FLUTTER_VERSION into $SDK (one time)" >&2
  curl -fsSL "$URL" -o "$work/$ARCHIVE"
  echo "$FLUTTER_SHA256  $work/$ARCHIVE" | sha256sum -c - >&2
  tar -xJf "$work/$ARCHIVE" -C "$work"
  mv "$work/flutter" "$SDK"
fi

# The SDK is owned by another user in some containers; git refuses that unless it is marked safe.
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$SDK" || git config --global --add safe.directory "$SDK"

printf 'export PATH="%s/bin:$PATH"\nexport FLUTTER_SUPPRESS_ANALYTICS=true\n' "$SDK"
