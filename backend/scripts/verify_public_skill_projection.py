"""Verify the public immutable GitHub Skill matches this checkout's projection."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import time
from typing import Callable
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SKILL_RELATIVE_PATH = ".agents/skills/offeru/SKILL.md"
MAX_RESPONSE_BYTES = 1_000_000
FETCH_TIMEOUT_SECONDS = 10
FETCH_ATTEMPTS = 4
RETRY_DELAYS_SECONDS = (0.5, 1.0, 2.0)
RETRYABLE_HTTP_STATUS = {408, 425, 429, 500, 502, 503, 504}
MARKER = re.compile(
    rb"^<!-- generated: offeru-skill-registry@([A-Za-z0-9][A-Za-z0-9._+-]*) "
    rb"sha256=([a-f0-9]{64}) -->$",
    re.MULTILINE,
)


class ProjectionCheckError(ValueError):
    """The published projection is missing, invalid, or differs from source."""


@dataclass(frozen=True)
class ProjectionMarker:
    version: str
    registry_hash: str


def public_skill_url(repository: str, commit_sha: str) -> str:
    """Build the raw URL only from a validated repository and immutable SHA."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ProjectionCheckError("repository must be an owner/repository pair")
    if any(part in {".", ".."} for part in repository.split("/")):
        raise ProjectionCheckError("repository contains an invalid path component")
    if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
        raise ProjectionCheckError("sha must be a full immutable 40-character commit SHA")
    return (
        f"https://raw.githubusercontent.com/{repository}/{commit_sha}/"
        f"{SKILL_RELATIVE_PATH}"
    )


def parse_marker(content: bytes, *, source: str) -> ProjectionMarker:
    matches = list(MARKER.finditer(content))
    if len(matches) != 1:
        raise ProjectionCheckError(
            f"{source} must contain exactly one valid generated Skill version marker"
        )
    return ProjectionMarker(
        version=matches[0].group(1).decode("ascii"),
        registry_hash=matches[0].group(2).decode("ascii"),
    )


def read_canonical_projection(
    project_root: Path = PROJECT_ROOT,
    *,
    commit_sha: str = "HEAD",
) -> bytes:
    """Read an immutable committed blob so checkout newline conversion cannot mask parity."""
    if commit_sha != "HEAD" and not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
        raise ProjectionCheckError("canonical Skill source must be HEAD or a full immutable commit SHA")
    try:
        result = subprocess.run(
            ["git", "show", f"{commit_sha}:{SKILL_RELATIVE_PATH}"],
            cwd=project_root,
            check=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ProjectionCheckError("could not read the canonical Skill blob from this checkout") from exc
    return result.stdout


def _response_bytes(response: object, expected_url: str) -> bytes:
    geturl = getattr(response, "geturl", None)
    final_url = geturl() if callable(geturl) else expected_url
    if final_url != expected_url:
        raise ProjectionCheckError("raw GitHub redirected away from the immutable Skill URL")
    status = getattr(response, "status", 200)
    if status != 200:
        raise ProjectionCheckError(f"raw GitHub returned HTTP {status}")
    payload = response.read(MAX_RESPONSE_BYTES + 1)  # type: ignore[attr-defined]
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ProjectionCheckError("published Skill exceeds the allowed response size")
    return payload


def fetch_public_skill(
    url: str,
    *,
    open_url: Callable[..., object] | None = None,
    sleep: Callable[[float], None] | None = None,
) -> bytes:
    """Fetch the public immutable raw file, retrying transient network errors boundedly."""
    parsed = urlparse(url)
    path_parts = parsed.path.lstrip("/").split("/")
    if (
        parsed.scheme != "https"
        or parsed.netloc != "raw.githubusercontent.com"
        or parsed.query
        or parsed.fragment
        or len(path_parts) != 7
        or path_parts[3:] != [".agents", "skills", "offeru", "SKILL.md"]
        or not re.fullmatch(r"[0-9a-f]{40}", path_parts[2])
    ):
        raise ProjectionCheckError(
            "Skill fetch URL must be an immutable raw.githubusercontent.com commit URL"
        )
    opener = open_url if open_url is not None else urlopen
    pause = sleep if sleep is not None else time.sleep
    request = Request(url, headers={"Accept": "text/plain", "User-Agent": "OfferU-Skill-Projection-Check"})
    delays = RETRY_DELAYS_SECONDS
    last_error = "unknown network error"

    for attempt in range(FETCH_ATTEMPTS):
        try:
            with opener(request, timeout=FETCH_TIMEOUT_SECONDS) as response:  # type: ignore[attr-defined]
                return _response_bytes(response, url)
        except HTTPError as exc:
            exc.close()
            if exc.code not in RETRYABLE_HTTP_STATUS:
                raise ProjectionCheckError(f"raw GitHub returned HTTP {exc.code}") from exc
            last_error = f"HTTP {exc.code}"
        except (URLError, TimeoutError, ConnectionError, socket.timeout) as exc:
            reason = getattr(exc, "reason", None)
            if isinstance(reason, ssl.SSLError) or isinstance(exc, ssl.SSLError):
                raise ProjectionCheckError("TLS validation failed while fetching public Skill") from exc
            last_error = str(reason or exc)[:200]
        except ssl.SSLError as exc:
            raise ProjectionCheckError("TLS validation failed while fetching public Skill") from exc
        except HTTPException as exc:
            last_error = str(exc)[:200]

        if attempt + 1 < FETCH_ATTEMPTS:
            pause(delays[min(attempt, len(delays) - 1)])

    raise ProjectionCheckError(
        f"public Skill fetch failed after {FETCH_ATTEMPTS} attempts: {last_error}"
    )


def verify_public_skill_projection(
    repository: str,
    commit_sha: str,
    *,
    project_root: Path = PROJECT_ROOT,
    fetch: Callable[[str], bytes] = fetch_public_skill,
    canonical_content: bytes | None = None,
) -> str:
    """Require valid equal markers and exact bytes for the canonical projection."""
    local = (
        canonical_content
        if canonical_content is not None
        else read_canonical_projection(project_root, commit_sha=commit_sha)
    )
    local_marker = parse_marker(local, source="canonical projection")
    url = public_skill_url(repository, commit_sha)
    remote = fetch(url)
    remote_marker = parse_marker(remote, source="public projection")
    if remote_marker != local_marker:
        raise ProjectionCheckError(
            "public Skill version marker differs from canonical projection "
            f"(public={remote_marker.version}/{remote_marker.registry_hash}, "
            f"local={local_marker.version}/{local_marker.registry_hash})"
        )
    if remote != local:
        raise ProjectionCheckError(
            "public Skill bytes differ from the canonical projection "
            f"(public_sha256={hashlib.sha256(remote).hexdigest()}, "
            f"local_sha256={hashlib.sha256(local).hexdigest()})"
        )
    return url


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify the immutable public GitHub Skill equals the canonical projection."
    )
    parser.add_argument("--repository", required=True, help="GitHub owner/repository")
    parser.add_argument("--sha", required=True, help="Full immutable commit SHA")
    args = parser.parse_args(argv)

    try:
        url = verify_public_skill_projection(args.repository, args.sha)
    except ProjectionCheckError as exc:
        print(f"Public OfferU Skill projection check failed: {exc}", file=sys.stderr)
        return 1
    print(f"Public OfferU Skill projection matches canonical bytes: {url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
