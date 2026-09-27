"""Propose a CHE code change as a validated patch. Never merges or deploys.

Runs in a GitHub Actions checkout. The model sees only tracked, allowlisted
source files, and its response must pass git apply and flutter analyze before a
draft pull request can be opened. An owner must inspect and merge that PR.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import PurePosixPath

MAX_CONTEXT = 95_000
MAX_PATCH = 80_000
ALLOWED_ROOTS = ("lib/", "test/")
ALLOWED_FILES = {"pubspec.yaml"}


def run(*args: str, input_text: str | None = None) -> str:
    p = subprocess.run(args, input=input_text, text=True, capture_output=True)
    if p.returncode:
        raise RuntimeError(f"{' '.join(args)} failed: {p.stderr[:1500]}")
    return p.stdout


def allowed(path: str) -> bool:
    p = PurePosixPath(path)
    return (
        not p.is_absolute()
        and ".." not in p.parts
        and ((path.startswith(ALLOWED_ROOTS) and path.endswith(".dart"))
             or path in ALLOWED_FILES)
        and not path.endswith((".key", ".p8", ".p12", ".env"))
    )


def source_context() -> str:
    names = run("git", "ls-files").splitlines()
    chunks = []
    size = 0
    for name in names:
        if not allowed(name) or name.startswith("test/"):
            continue
        try:
            with open(name, "r", encoding="utf-8") as f:
                contents = f.read()
        except (OSError, UnicodeError):
            continue
        if size + len(contents) > MAX_CONTEXT:
            continue
        chunks.append(f"FILE: {name}\n{contents}\nEND FILE\n")
        size += len(contents)
    if not chunks:
        raise RuntimeError("No suitable CHE source files in this checkout.")
    return "\n".join(chunks)


def model_patch(request: str, model: str, key: str, context: str) -> str:
    prompt = (
        "You edit a Flutter personal assistant called CHE. Produce ONLY a unified "
        "git diff patch with diff --git headers, no Markdown. Make the smallest "
        "change that fulfills the owner's request. Do not modify secrets, CI, "
        "permissions, signing, or unrelated behavior. Never claim an unbuilt "
        "phone capability. Request:\n" + request + "\n\nSource:\n" + context
    )
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        "https://ollama.com/api/chat",
        data=payload,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        answer = json.load(resp)
    return str(answer.get("message", {}).get("content", "")).strip()


def validate_patch(patch: str) -> None:
    if not patch or len(patch) > MAX_PATCH:
        raise ValueError("The proposed patch is empty or too large.")
    if patch.startswith("```"):
        raise ValueError("The model returned Markdown rather than a patch.")
    paths = re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch, re.M)
    if not paths or len(paths) > 6:
        raise ValueError("Expected a patch for one to six files.")
    for old, new in paths:
        if old != new or not allowed(old):
            raise ValueError(f"Disallowed file change: {old} -> {new}")
        run("git", "ls-files", "--error-unmatch", "--", old)
    if "GIT binary patch" in patch or "deleted file mode" in patch:
        raise ValueError("Binary changes and deletions require manual review.")
    run("git", "apply", "--check", "-", input_text=patch)
    listed = run("git", "apply", "--numstat", "-", input_text=patch)
    actual = [line.split("\t", 2)[2] for line in listed.splitlines()]
    if sorted(actual) != sorted(old for old, _ in paths):
        raise ValueError("Patch contains unlisted or renamed files.")


def main() -> int:
    request = os.environ.get("CHE_CHANGE_REQUEST", "").strip()
    model = os.environ.get("CHE_CHANGE_MODEL", "").strip()
    key = os.environ.get("OLLAMA_API_KEY", "").strip()
    if not request or len(request) > 2000 or not model or not key:
        raise ValueError("A request, model, and secret OLLAMA_API_KEY are required.")
    patch = model_patch(request, model, key, source_context())
    validate_patch(patch)
    run("git", "apply", "-", input_text=patch)
    run("git", "diff", "--check")
    if not run("git", "status", "--porcelain"):
        raise ValueError("The proposed change has no effect.")
    print("CHE proposal applied; awaiting analysis and owner review.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"CHE proposal stopped: {exc}", file=sys.stderr)
        sys.exit(1)
