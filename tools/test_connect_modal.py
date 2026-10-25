"""End-to-end regression for tools/modal/connect_modal.sh, with Modal, curl and wrangler replaced by stubs.

The script runs for real: it issues a token, calls the stubs in order, and decides what to report. The tests check
the outcomes that matter to the owner: a failed or skipped deploy is never reported connected, the Worker secret is
written only after the authenticated health check, and no secret value reaches the output.
"""
import json
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "modal" / "connect_modal.sh"
WORKFLOW = HERE.parent / ".github" / "workflows" / "che-modal-deploy.yml"
URL = "https://owner--che-gpu-serve.modal.run"
GOOD_ID = "ak-AbCdEf123456"
GOOD_SECRET = "as-ZyXwVu987654"
CF_TOKEN = "cf-test-token-0123456789"

STUBS = {
    # modal: records each call, deploys with a URL line; behaviour switched by env STUB_DEPLOY_MODE.
    "modal": """#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/modal_calls.log"
case "$1 $2" in
  "secret create")
    if [ "${STUB_SECRET_FAIL:-}" = 1 ]; then echo "Error: secret store unavailable" >&2; exit 1; fi
    # Record the secret value so the test can check it matches the Worker's token.
    echo "${4#CHE_GPU_ENDPOINT_TOKEN=}" > "$STUB_DIR/modal_secret_arg"
    exit 0 ;;
esac
if [ "$1" = deploy ]; then
  case "${STUB_DEPLOY_MODE:-ok}" in
    ok) echo "Created web function serve => $STUB_URL"; echo "Deployed."; exit 0 ;;
    token) echo "Error: Token missing or invalid for workspace owner (ak-AbCdEf123456)"; exit 1 ;;
    nourl) echo "Deployed app, no endpoint line here"; exit 0 ;;
  esac
fi
exit 0
""",
    # curl: "-w" is the unauthenticated probe (prints the status code); the authenticated call prints the health JSON.
    "curl": """#!/usr/bin/env bash
case " $* " in
  *" -w "*) echo "${STUB_ANON:-401}"; exit 0 ;;
esac
if [ "${STUB_HEALTH:-ok}" = fail ]; then echo "curl: (22) The requested URL returned error: 500" >&2; exit 22; fi
if [ "${STUB_HEALTH:-ok}" = wrongapp ]; then echo '{"app":"other","version":"1"}'; exit 0; fi
echo '{"app":"che-gpu","version":"2026.10.25"}'
""",
    # wrangler: reads the secret from stdin, records it, and fails when STUB_WRANGLER_FAIL=1.
    "wrangler": """#!/usr/bin/env bash
cat > "$STUB_DIR/worker_secret_value"
echo "$*" >> "$STUB_DIR/wrangler_calls.log"
if [ "${STUB_WRANGLER_FAIL:-}" = 1 ]; then echo "Authentication error [code: 10000]" >&2; exit 1; fi
echo "Success! Uploaded secret MODAL_TOKEN"
""",
}


class ConnectModalE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="connect-modal-"))
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name, body in STUBS.items():
            path = self.bin / name
            path.write_text(body)
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        self.summary = self.tmp / "summary.md"
        self.summary.write_text("")

    def run_script(self, env_overrides=None, drop=()):
        env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "STUB_DIR": str(self.tmp),
            "STUB_URL": URL,
            "MODAL_TOKEN_ID": GOOD_ID,
            "MODAL_TOKEN_SECRET": GOOD_SECRET,
            "CLOUDFLARE_API_TOKEN": CF_TOKEN,
            "GITHUB_STEP_SUMMARY": str(self.summary),
            "APP_DIR": str(self.tmp),  # where the stubbed deploy runs; the real file is not needed
            "WORKER_DIR": str(self.tmp),
            "MODAL_CMD": str(self.bin / "modal"),
            "CURL_CMD": str(self.bin / "curl"),
            "WRANGLER_CMD": str(self.bin / "wrangler"),
        }
        for key in drop:
            env.pop(key, None)
        env.update(env_overrides or {})
        proc = subprocess.run(
            ["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60
        )
        output = proc.stdout + proc.stderr
        return proc.returncode, output, self.summary.read_text()

    def read(self, name):
        path = self.tmp / name
        return path.read_text() if path.exists() else None

    def assert_no_secret_in(self, output, summary):
        for value in (GOOD_ID, GOOD_SECRET, CF_TOKEN):
            self.assertNotIn(value, output)
            self.assertNotIn(value, summary)
        token = self.read("modal_secret_arg")
        if token:
            self.assertNotIn(token.strip(), output)
            self.assertNotIn(token.strip(), summary)

    def test_happy_path_deploys_verifies_and_connects(self):
        code, output, summary = self.run_script()
        self.assertEqual(code, 0, output)
        self.assertIn("CONNECTED:", output)
        self.assertIn("CHE Modal app deployed and connected", summary)
        # The Worker secret is exactly bearer:<the token Modal stores>@<endpoint>, sent on stdin.
        token = self.read("modal_secret_arg").strip()
        self.assertRegex(token, r"^[0-9a-f]{64}$")
        self.assertEqual(self.read("worker_secret_value"), f"bearer:{token}@{URL}")
        self.assert_no_secret_in(output, summary)

    def test_deploy_failure_shows_the_real_error_and_never_connects(self):
        code, output, summary = self.run_script({"STUB_DEPLOY_MODE": "token"})
        self.assertNotEqual(code, 0)
        # The diagnostic line mentions "token" and must still be shown; the old grep filter hid it.
        self.assertIn("Token missing or invalid", output)
        self.assertIn("modal deploy failed", summary)
        self.assertNotIn("connected", summary.lower().replace("not connected", ""))
        self.assertIsNone(self.read("wrangler_calls.log"))
        self.assert_no_secret_in(output, summary)

    def test_missing_endpoint_url_never_connects(self):
        code, output, summary = self.run_script({"STUB_DEPLOY_MODE": "nourl"})
        self.assertNotEqual(code, 0)
        self.assertIn("no che-gpu endpoint URL", output)
        self.assertIsNone(self.read("wrangler_calls.log"))
        self.assertNotIn("CHE Modal app deployed and connected", summary)

    def test_unauthenticated_request_not_refused_never_connects(self):
        code, output, summary = self.run_script({"STUB_ANON": "200"})
        self.assertNotEqual(code, 0)
        self.assertIn("did not refuse an unauthenticated request", output)
        self.assertIsNone(self.read("wrangler_calls.log"))

    def test_authenticated_health_failure_never_connects(self):
        code, output, summary = self.run_script({"STUB_HEALTH": "fail"})
        self.assertNotEqual(code, 0)
        self.assertIn("authenticated /health failed", output)
        self.assertIsNone(self.read("wrangler_calls.log"))
        self.assert_no_secret_in(output, summary)

    def test_health_answering_another_app_never_connects(self):
        code, output, summary = self.run_script({"STUB_HEALTH": "wrongapp"})
        self.assertNotEqual(code, 0)
        self.assertIn("not as the che-gpu app", output)
        self.assertIsNone(self.read("wrangler_calls.log"))

    def test_worker_write_failure_is_reported_not_connected(self):
        code, output, summary = self.run_script({"STUB_WRANGLER_FAIL": "1"})
        self.assertNotEqual(code, 0)
        self.assertIn("could not write the Worker secret", output)
        self.assertNotIn("CHE Modal app deployed and connected", summary)
        self.assert_no_secret_in(output, summary)

    def test_missing_secret_stops_before_any_modal_call(self):
        code, output, summary = self.run_script(drop=("MODAL_TOKEN_SECRET",))
        self.assertNotEqual(code, 0)
        self.assertIn("MODAL_TOKEN_SECRET", output)
        self.assertIsNone(self.read("modal_calls.log"))
        self.assertIn("NOT connected", summary)

    def test_wrong_token_format_stops_before_any_modal_call(self):
        code, output, summary = self.run_script({"MODAL_TOKEN_ID": "not-a-modal-id"})
        self.assertNotEqual(code, 0)
        self.assertIn("token-ID format", output)
        self.assertIsNone(self.read("modal_calls.log"))
        self.assertNotIn("not-a-modal-id", output)

    def test_workflow_runs_this_script_and_not_the_old_filtered_inline_steps(self):
        text = WORKFLOW.read_text()
        self.assertIn("tools/modal/connect_modal.sh", text)
        # The old keyword filter hid the real deploy error; it must be gone from the workflow.
        self.assertIsNone(re.search(r"grep -v -i -E 'token\|secret'", text))
        # A skipped deploy must not look green: no "ready" output gate that lets the job pass without connecting.
        self.assertNotIn("steps.secrets.outputs.ready", text)


if __name__ == "__main__":
    unittest.main()
