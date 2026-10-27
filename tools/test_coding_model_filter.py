"""Regression: CHE's coding runtime must never choose a model its provider retired (llama-3.3 returned HTTP 404).

Model selection moved from the workflow's shell filters into server/cloudflare/model_router.mjs (2026-10-27,
zero-cost router). This checks that the router's retired-model guard and the Groq listing filter still drop
llama-3.3, and that the workflow no longer ranks models with its own grep filters.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "che-opencode-runtime.yml"
ROUTER = ROOT / "server" / "cloudflare" / "model_router.mjs"


class CodingModelFilter(unittest.TestCase):
    def setUp(self):
        self.workflow = WORKFLOW.read_text(encoding="utf-8")
        self.router = ROUTER.read_text(encoding="utf-8")

    def test_the_router_never_ranks_the_retired_llama_3_3_model(self):
        self.assertRegex(self.router, r"RETIRED_MODELS = Object\.freeze\(\[/llama-3\\\.3/i\]\)")
        self.assertIn("retired_by_provider", self.router)

    def test_the_groq_listing_filter_drops_llama_3_3(self):
        line = next(l for l in self.router.splitlines() if l.strip().startswith("groq: { keep:"))
        self.assertIn("llama-3\\.3", line)
        self.assertNotIn("llama", line.split("drop:")[0], "llama is never a keep keyword")

    def test_the_workflow_has_no_shell_model_filters_left(self):
        self.assertNotRegex(self.workflow, r"(list|ranked)=\$\(printf '%s\\n' \"\$list\"")


if __name__ == "__main__":
    unittest.main()
