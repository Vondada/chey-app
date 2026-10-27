"""Regression checks on GitHub Actions triggers that wasted runs or failed on every push.

Reliability audit 2026-10-25 (docs/failure_inventory/infra_app_voice.md):
- INF-01: "Wake CHE for Flagstaff mail" failed on 195 of its che-mailbox pushes in two
  weeks: a push that adds no mailbox line (handoff, brief, runtime or archive file)
  made `grep '^+{'` exit 1, which `set -o pipefail` turned into a failed job instead
  of a skip.
- INF-02: "CHE Autopilot" listened to every `check_run` in the repository, including
  the check runs of its own skipped jobs, so it started ~290 skipped runs a day on
  main, and it dispatched AI repairs for the non-gating Cloudflare "Workers Builds"
  check while the owner was not in a session.
These run anywhere with Python 3 + PyYAML + git.
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"


def load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text())


def triggers(doc: dict) -> dict:
    # PyYAML reads the bare key `on` as the boolean True.
    return doc.get("on") or doc.get(True) or {}


def step(doc: dict, job: str, name: str) -> dict:
    for s in doc["jobs"][job]["steps"]:
        if s.get("name") == name:
            return s
    raise AssertionError(f"{job} has no step {name!r}")


class FlagstaffWakeTest(unittest.TestCase):
    script = step(load("flagstaff-wake.yml"), "wake", "Find new peer messages")["run"]

    def run_on_commit(self, files: dict) -> tuple:
        with tempfile.TemporaryDirectory() as repo:
            git = lambda *a: subprocess.run(["git", "-C", repo, *a], check=True, capture_output=True, text=True)
            git("init", "-q")
            git("config", "user.email", "t@example.com")
            git("config", "user.name", "t")
            os.makedirs(f"{repo}/mailbox/briefs")
            Path(f"{repo}/mailbox/claude.jsonl").write_text('{"id":"old","from":"claude","to":"che","text":"x"}\n')
            git("add", "-A")
            git("commit", "-qm", "base")
            for rel, text in files.items():
                path = Path(repo, rel)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(path.read_text() + text if path.exists() else text)
            git("add", "-A")
            git("commit", "-qm", "push")
            sha = git("rev-parse", "HEAD").stdout.strip()
            out = Path(repo, "gh_output")
            out.write_text("")
            env = {**os.environ, "GITHUB_SHA": sha, "GITHUB_OUTPUT": str(out)}
            # Same shell flags GitHub uses for `shell: bash`.
            proc = subprocess.run(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", self.script],
                                  cwd=repo, env=env, capture_output=True, text=True)
            return proc.returncode, out.read_text(), proc.stderr

    def test_push_without_mailbox_lines_skips_instead_of_failing(self):
        code, output, err = self.run_on_commit({"mailbox/briefs/LIVE-HANDOFF.md": "# handoff\n"})
        self.assertEqual(code, 0, err)
        self.assertIn("skip=true", output)

    def test_che_own_reply_is_skipped(self):
        code, output, err = self.run_on_commit({"mailbox/claude.jsonl": '{"id":"r1","from":"che","to":"claude","text":"y"}\n'})
        self.assertEqual(code, 0, err)
        self.assertIn("skip=true", output)

    def test_archive_move_is_not_new_mail(self):
        code, output, err = self.run_on_commit({"mailbox/archive/claude.jsonl": '{"id":"a1","from":"claude","to":"che","text":"z"}\n'})
        self.assertEqual(code, 0, err)
        self.assertIn("skip=true", output)

    def test_peer_message_is_still_delivered(self):
        code, output, err = self.run_on_commit({"mailbox/claude.jsonl": '{"id":"m1","from":"claude","to":"che","text":"hi"}\n'})
        self.assertEqual(code, 0, err)
        self.assertIn("skip=false", output)
        self.assertIn('message_ids=["m1"]', output)


class AutopilotTriggerTest(unittest.TestCase):
    doc = load("che-autopilot.yml")

    def test_no_check_run_trigger(self):
        # check_run cannot be filtered by name, so every completed check run in the repo
        # (its own jobs included) started a run. Workers Builds is non-gating
        # (release_status.mjs NON_GATING), and the gating Flutter check still arrives
        # through workflow_run.
        on = triggers(self.doc)
        self.assertNotIn("check_run", on)
        self.assertNotIn("check_suite", on)
        self.assertNotIn("schedule", on)
        self.assertEqual(on["workflow_run"]["workflows"], ["Check CHE Flutter client"])

    def test_jobs_do_not_reference_the_removed_trigger(self):
        for name, job in self.doc["jobs"].items():
            self.assertNotIn("check_run", str(job.get("if", "")), name)

    def test_no_workflow_runs_ai_on_a_schedule(self):
        # Owner rule (AGENTS.md): nothing runs on a schedule spending AI usage.
        for path in sorted(WORKFLOWS.glob("*.yml")):
            on = triggers(yaml.safe_load(path.read_text()))
            if isinstance(on, dict) and "schedule" in on:
                text = path.read_text()
                for marker in ("OPENROUTER", "ANTHROPIC", "OPENAI_API_KEY", "opencode"):
                    self.assertNotIn(marker, text, f"{path.name} is scheduled and uses {marker}")


if __name__ == "__main__":
    unittest.main()
