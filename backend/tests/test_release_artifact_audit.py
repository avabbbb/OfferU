from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from scripts.release.audit_artifacts import audit_artifact_tree


class ReleaseArtifactAuditTests(unittest.TestCase):
    def test_clean_artifact_tree_has_no_findings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "OfferU-0.4.0-setup.exe").write_bytes(b"signed installer bytes")
            (root / "SHA256SUMS.txt").write_text("hash  installer.exe\n", encoding="utf-8")
            result = audit_artifact_tree(root)

        self.assertEqual(result["status"], "clear")
        self.assertEqual(result["findings"], [])
        self.assertEqual(result["file_count"], 2)

    def test_secret_and_sensitive_filename_are_reported_without_values(self) -> None:
        canary = b"OFFERU_RELEASE_CANARY_SECRET_20260901_xxxx"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "auth.json").write_bytes(b'{"token":"hidden"}')
            (root / "installer.bin").write_bytes(
                b"Bearer abcdefghijklmnopqrstuvwxyz1234567890 " + canary
            )
            result = audit_artifact_tree(root)

        self.assertEqual(result["status"], "fail")
        findings = result["findings"]
        assert isinstance(findings, list)
        self.assertEqual(
            {(item["path"], item["kind"]) for item in findings},
            {
                ("auth.json", "sensitive_filename"),
                ("installer.bin", "bearer_token"),
                ("installer.bin", "offeru_canary"),
            },
        )
        self.assertNotIn("hidden", str(result))
        self.assertNotIn(canary.decode(), str(result))

    def test_text_pii_is_reported_without_values(self) -> None:
        email = b"candidate.private@private-mail.invalid"
        phone = b"+86 13812345678"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "diagnostic.json").write_bytes(
                b'{"email":"' + email + b'","phone":"' + phone + b'"}'
            )
            (root / "installer.bin").write_bytes(email + b" " + phone)
            result = audit_artifact_tree(root)

        self.assertEqual(result["status"], "fail")
        findings = result["findings"]
        assert isinstance(findings, list)
        self.assertEqual(
            {(item["path"], item["kind"]) for item in findings},
            {
                ("diagnostic.json", "email_address"),
                ("diagnostic.json", "phone_number"),
            },
        )
        self.assertNotIn(email.decode(), str(result))
        self.assertNotIn(phone.decode(), str(result))

    def test_symlink_is_reported_without_following_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root.parent / f"offeru-audit-outside-{root.name}.txt"
            outside.write_text("not part of the artifact", encoding="utf-8")
            link = root / "linked.txt"
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable in this Windows test environment")
            try:
                result = audit_artifact_tree(root)
            finally:
                outside.unlink(missing_ok=True)

        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["file_count"], 0)
        self.assertEqual(result["findings"], [{"path": "linked.txt", "kind": "symlink"}])

    def test_symlink_root_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            target = parent / "target"
            target.mkdir()
            link = parent / "root-link"
            try:
                link.symlink_to(target, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable in this Windows test environment")
            with self.assertRaisesRegex(ValueError, "root must not be a symlink"):
                audit_artifact_tree(link)


if __name__ == "__main__":
    unittest.main()
