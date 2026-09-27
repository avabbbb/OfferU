from __future__ import annotations

from contextlib import closing
from io import BytesIO
from pathlib import Path
import socket
import subprocess
import unittest
from urllib.error import HTTPError, URLError
from unittest.mock import patch

from scripts.verify_public_skill_projection import (
    FETCH_ATTEMPTS,
    ProjectionCheckError,
    fetch_public_skill,
    parse_marker,
    public_skill_url,
    read_canonical_projection,
    verify_public_skill_projection,
)


REPOSITORY = "offeru-owner/OfferU"
COMMIT_SHA = "a" * 40
MARKER = b"<!-- generated: offeru-skill-registry@2026-09-28.1 sha256=" + b"b" * 64 + b" -->"
SKILL = b"---\nname: offeru\n---\n" + MARKER + b"\nCanonical body\n"


class FakeResponse(BytesIO):
    status = 200

    def __init__(self, content: bytes, url: str):
        super().__init__(content)
        self._url = url

    def geturl(self) -> str:
        return self._url


class PublicSkillProjectionTests(unittest.TestCase):
    def test_url_requires_owner_repo_and_full_immutable_sha(self) -> None:
        expected = (
            "https://raw.githubusercontent.com/offeru-owner/OfferU/"
            + COMMIT_SHA
            + "/.agents/skills/offeru/SKILL.md"
        )
        self.assertEqual(public_skill_url(REPOSITORY, COMMIT_SHA), expected)
        for repository, sha in (
            ("https://raw.githubusercontent.com/owner/repo", COMMIT_SHA),
            ("owner/repo/branch", COMMIT_SHA),
            ("owner/repo", "main"),
            ("owner/repo", "a" * 39),
        ):
            with self.subTest(repository=repository, sha=sha), self.assertRaises(ProjectionCheckError):
                public_skill_url(repository, sha)

    def test_marker_must_exist_exactly_once_and_be_well_formed(self) -> None:
        parsed = parse_marker(SKILL, source="fixture")
        self.assertEqual(parsed.version, "2026-09-28.1")
        self.assertEqual(parsed.registry_hash, "b" * 64)
        for invalid in (b"no marker\n", SKILL + MARKER + b"\n", SKILL.replace(b"b" * 64, b"z" * 64)):
            with self.subTest(invalid=invalid[:30]), self.assertRaises(ProjectionCheckError):
                parse_marker(invalid, source="fixture")

    def test_public_projection_requires_same_marker_and_exact_bytes(self) -> None:
        url = public_skill_url(REPOSITORY, COMMIT_SHA)
        with self.subTest("matching bytes"):
            result = verify_public_skill_projection(
                REPOSITORY,
                COMMIT_SHA,
                fetch=lambda requested: self._assert_url_and_return(requested, url, SKILL),
                canonical_content=SKILL,
            )
            self.assertEqual(result, url)

        for remote in (
            SKILL.replace(b"Canonical body", b"Changed body"),
            SKILL.replace(b"2026-09-28.1", b"2026-09-27.1"),
            b"not a generated OfferU Skill\n",
        ):
            with self.subTest(remote=remote[-24:]), self.assertRaises(ProjectionCheckError):
                verify_public_skill_projection(
                    REPOSITORY,
                    COMMIT_SHA,
                    fetch=lambda requested, remote=remote: remote,
                    canonical_content=SKILL,
                )

    def test_canonical_projection_is_read_from_the_requested_immutable_commit(self) -> None:
        expected = subprocess.CompletedProcess(args=[], returncode=0, stdout=SKILL, stderr=b"")
        with patch("scripts.verify_public_skill_projection.subprocess.run", return_value=expected) as run:
            self.assertEqual(read_canonical_projection(Path("H:/repo"), commit_sha=COMMIT_SHA), SKILL)
        run.assert_called_once_with(
            ["git", "show", f"{COMMIT_SHA}:.agents/skills/offeru/SKILL.md"],
            cwd=Path("H:/repo"),
            check=True,
            capture_output=True,
        )

        with self.assertRaisesRegex(ProjectionCheckError, "full immutable"):
            read_canonical_projection(Path("H:/repo"), commit_sha="main")

    def test_fetch_retries_transient_errors_only_with_a_bound(self) -> None:
        url = public_skill_url(REPOSITORY, COMMIT_SHA)
        pauses: list[float] = []
        attempts = 0

        def open_url(_request: object, *, timeout: int):
            nonlocal attempts
            self.assertEqual(timeout, 10)
            attempts += 1
            if attempts < 3:
                raise URLError(socket.timeout("transient"))
            return closing(FakeResponse(SKILL, url))

        result = fetch_public_skill(url, open_url=open_url, sleep=pauses.append)
        self.assertEqual(result, SKILL)
        self.assertEqual(attempts, 3)
        self.assertEqual(pauses, [0.5, 1.0])

        attempts = 0
        pauses.clear()

        def always_timeout(_request: object, *, timeout: int):
            nonlocal attempts
            attempts += 1
            raise URLError(socket.timeout("offline"))

        with self.assertRaisesRegex(ProjectionCheckError, f"after {FETCH_ATTEMPTS} attempts"):
            fetch_public_skill(url, open_url=always_timeout, sleep=pauses.append)
        self.assertEqual(attempts, FETCH_ATTEMPTS)
        self.assertEqual(len(pauses), FETCH_ATTEMPTS - 1)

    def test_fetch_does_not_retry_permanent_http_errors_or_redirects(self) -> None:
        url = public_skill_url(REPOSITORY, COMMIT_SHA)
        attempts = 0

        def not_found(_request: object, *, timeout: int):
            nonlocal attempts
            attempts += 1
            raise HTTPError(url, 404, "not found", {}, None)

        with self.assertRaisesRegex(ProjectionCheckError, "HTTP 404"):
            fetch_public_skill(url, open_url=not_found, sleep=lambda _delay: self.fail("must not retry"))
        self.assertEqual(attempts, 1)

        def redirected(_request: object, *, timeout: int):
            return closing(FakeResponse(SKILL, "https://example.com/skill.md"))

        with self.assertRaisesRegex(ProjectionCheckError, "redirected"):
            fetch_public_skill(url, open_url=redirected)

    def test_fetch_rejects_mutable_refs_and_noncanonical_urls_before_network(self) -> None:
        for url in (
            "https://raw.githubusercontent.com/offeru-owner/OfferU/main/.agents/skills/offeru/SKILL.md",
            "https://user@raw.githubusercontent.com/offeru-owner/OfferU/" + COMMIT_SHA + "/.agents/skills/offeru/SKILL.md",
            "https://raw.githubusercontent.com/offeru-owner/OfferU/" + COMMIT_SHA + "/.agents/skills/offeru/SKILL.md?raw=1",
        ):
            with self.subTest(url=url), self.assertRaises(ProjectionCheckError):
                fetch_public_skill(
                    url,
                    open_url=lambda *_args, **_kwargs: self.fail("must reject before network"),
                )

    @staticmethod
    def _assert_url_and_return(requested: str, expected: str, content: bytes) -> bytes:
        if requested != expected:
            raise AssertionError(f"unexpected URL: {requested}")
        return content


if __name__ == "__main__":
    unittest.main()
