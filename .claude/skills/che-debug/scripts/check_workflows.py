#!/usr/bin/env python3
"""Parses each workflow as YAML and syntax-checks every inline Node script
written as a heredoc (`node --input-type=module <<'JS'` as an ES module,
`node <<'NODE'` as CommonJS) with node --check."""
import os, re, subprocess, sys, tempfile

try:
    import yaml
except ImportError:  # PyYAML is on GitHub runners; say so instead of passing silently
    print("PyYAML missing: workflows NOT checked")
    sys.exit(1)

failed, scripts = [], 0
for path in sys.argv[1:]:
    try:
        doc = yaml.safe_load(open(path))
    except Exception as error:  # noqa: BLE001
        failed.append(f"{path}: YAML error {error}")
        continue
    for job_name, job in (doc.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            run = step.get("run") or ""
            blocks = re.findall(r"<<'(JS|NODE)'\n(.*?)\n\s*\1\b", run, re.S)
            for kind, block in blocks:
                scripts += 1
                with tempfile.NamedTemporaryFile("w", suffix=".mjs" if kind == "JS" else ".cjs", delete=False) as handle:
                    handle.write(block)
                result = subprocess.run(["node", "--check", handle.name], capture_output=True, text=True)
                os.unlink(handle.name)
                if result.returncode:
                    detail = (result.stderr.strip().splitlines() or ["syntax error"])[-1]
                    failed.append(f"{path} › {job_name} › {step.get('name', '?')}: {detail}")
for line in failed:
    print(line)
print(f"{len(sys.argv) - 1} files, {scripts} inline scripts" if not failed else f"{len(failed)} problem(s)")
sys.exit(1 if failed else 0)
