"""Shared SideStore-visible version generator for GitHub Actions and Codemagic.

The SideStore source schema exposes a marketing version, not CFBundleVersion.
Use the same monotonically increasing X.Y.Z scheme in both iPhone builders.
"""
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

EPOCH_2026 = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp())
PATCH_SCALE = 100_000_000


def marketing_version(base_version, timestamp=None):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", base_version.strip())
    if not match:
        raise ValueError("Expected a numeric X.Y.Z app version")
    when = int(time.time()) if timestamp is None else int(timestamp)
    if when < EPOCH_2026:
        raise ValueError("Build timestamp must be 2026 or later")
    major, minor, patch = (int(group) for group in match.groups())
    # The fixed 2026 epoch keeps iOS's third component smaller than Unix time.
    # This remains increasing across workflows, CI run counters and rebuilds.
    return f"{major}.{minor}.{patch * PATCH_SCALE + when - EPOCH_2026}"


def pubspec_version(path="pubspec.yaml"):
    match = re.search(r"(?m)^version:\s*([^+\s]+)\+[0-9]+\s*$", Path(path).read_text())
    if not match:
        raise ValueError("pubspec.yaml needs version: X.Y.Z+N")
    return match.group(1)


if __name__ == "__main__":
    try:
        print(marketing_version(pubspec_version(sys.argv[1] if len(sys.argv) > 1 else "pubspec.yaml")))
    except (ValueError, OSError) as exc:
        sys.exit(str(exc))
