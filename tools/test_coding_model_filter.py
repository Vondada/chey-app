"""Regression: CHE's coding runtime must never choose a model its provider retired (llama-3.3 returned HTTP 404).

Reads the Model-selection step of .github/workflows/che-opencode-runtime.yml and checks the filters, so a model
dropped by its provider cannot creep back in through a broad keyword such as "llama".
"""
import re
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "che-opencode-runtime.yml"


class CodingModelFilter(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_openrouter_and_cerebras_filters_do_not_match_llama(self):
        for line in self.text.splitlines():
            if line.strip().startswith(("openrouter) list=", "cerebras) list=")):
                self.assertNotIn("llama", line, line.strip())

    def test_ranking_excludes_the_retired_llama_3_3_model(self):
        self.assertRegex(self.text, r"grep -viE '[^']*llama-3\\\.3[^']*'")

    def test_the_retired_model_is_not_selectable_anywhere_in_the_filters(self):
        for line in self.text.splitlines():
            if re.search(r"(list=\$\(printf|ranked=\$\(printf)", line):
                if "llama" in line:
                    self.assertIn("llama-3\\.3", line, line.strip())


if __name__ == "__main__":
    unittest.main()
