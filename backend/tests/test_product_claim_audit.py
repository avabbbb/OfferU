from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from scripts.release.audit_product_claims import audit_product_claims


class ProductClaimAuditTests(unittest.TestCase):
    def test_repository_surfaces_have_no_unqualified_high_risk_claims(self) -> None:
        root = Path(__file__).resolve().parents[2]
        result = audit_product_claims(root)
        self.assertEqual(result["status"], "clear")
        self.assertEqual(result["findings"], [])
        self.assertGreater(int(result["surface_file_count"]), 0)

    def test_unsafe_claim_is_reported_without_copying_source_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text(
                "OfferU automatically submits applications.\n",
                encoding="utf-8",
            )
            result = audit_product_claims(root)

        self.assertEqual(result["status"], "fail")
        self.assertEqual(
            result["findings"],
            [
                {
                    "path": "README.md",
                    "line": 1,
                    "category": "automatic_external_write",
                }
            ],
        )
        self.assertNotIn("automatically submits", str(result))

    def test_negative_and_fixture_claims_are_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text(
                "OfferU 不会自动提交申请。\n"
                "Fixture benchmark 不代表实时市场数据。\n"
                "Public Release 尚未完成。\n",
                encoding="utf-8",
            )
            result = audit_product_claims(root)

        self.assertEqual(result["status"], "clear")
        self.assertEqual(result["findings"], [])


if __name__ == "__main__":
    unittest.main()
