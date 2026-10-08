"""Regression tests for SideStore version ordering across CI providers."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("che_mobile_version", Path(__file__).with_name("mobile_version.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MobileVersionTests(unittest.TestCase):
    def test_new_build_replaces_installed_codemagic_version(self):
        latest = module.marketing_version("1.4.10", module.EPOCH_2026 + 24_200_000)
        self.assertGreater(tuple(map(int, latest.split("."))), (1, 4, 1000371))
        self.assertEqual(latest, "1.4.1024200000")

    def test_versions_increase_across_build_providers(self):
        first = module.marketing_version("1.4.10", module.EPOCH_2026 + 24_200_000)
        second = module.marketing_version("1.4.10", module.EPOCH_2026 + 24_200_121)
        self.assertGreater(tuple(map(int, second.split("."))), tuple(map(int, first.split("."))))
        self.assertGreater(module.marketing_version("1.4.11", module.EPOCH_2026 + 24_200_121), second)

    def test_bad_base_and_old_timestamp_are_rejected(self):
        with self.assertRaises(ValueError):
            module.marketing_version("1.4.10+19", module.EPOCH_2026 + 1)
        with self.assertRaises(ValueError):
            module.marketing_version("1.4.10", module.EPOCH_2026 - 1)


if __name__ == "__main__":
    unittest.main()
