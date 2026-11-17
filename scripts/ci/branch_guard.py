from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse


class GuardError(RuntimeError):
    pass


def git(root: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "git command failed"
        raise GuardError(f"git {' '.join(args)}: {detail}")
    return result.stdout.strip()


@dataclass(frozen=True)
class BaselineState:
    mode: str
    repository: str
    branch: str
    head: str
    base_ref: str
    base_sha: str
    merge_base: str
    ahead: int
    behind: int
    dirty: bool
    named_local_branches: int
    named_branches: list[str]
    worktree_count: int
    fetched: bool


def discover_root(explicit: str | None = None) -> Path:
    cwd = Path(explicit).resolve() if explicit else Path.cwd()
    root = git(cwd, "rev-parse", "--show-toplevel")
    return Path(root).resolve()


def fetch_base(root: Path, base_ref: str) -> None:
    if not base_ref.startswith("origin/"):
        raise GuardError("automatic fetch requires a base ref under origin/<branch>")
    branch = base_ref.split("/", 1)[1]
    git(root, "fetch", "--quiet", "origin", branch)


def collect_state(root: Path, *, mode: str, base_ref: str, do_fetch: bool) -> BaselineState:
    fetched = False
    if do_fetch:
        fetch_base(root, base_ref)
        fetched = True

    head = git(root, "rev-parse", "HEAD")
    base_sha = git(root, "rev-parse", base_ref)
    merge_base = git(root, "merge-base", "HEAD", base_ref)
    branch = git(root, "branch", "--show-current", check=False) or "(detached)"
    ahead = int(git(root, "rev-list", "--count", f"{base_ref}..HEAD") or "0")
    behind = int(git(root, "rev-list", "--count", f"HEAD..{base_ref}") or "0")
    dirty = bool(git(root, "status", "--porcelain", "--untracked-files=normal", check=False))
    branches_text = git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads", check=False)
    branches = sorted(line for line in branches_text.splitlines() if line.strip())
    worktrees_text = git(root, "worktree", "list", "--porcelain", check=False)
    worktree_count = sum(1 for line in worktrees_text.splitlines() if line.startswith("worktree "))
    return BaselineState(
        mode=mode,
        repository=str(root),
        branch=branch,
        head=head,
        base_ref=base_ref,
        base_sha=base_sha,
        merge_base=merge_base,
        ahead=ahead,
        behind=behind,
        dirty=dirty,
        named_local_branches=len(branches),
        named_branches=branches,
        worktree_count=worktree_count,
        fetched=fetched,
    )


def evaluate(
    state: BaselineState,
    *,
    allow_dirty: bool,
    max_named_branches: int,
) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    warnings: list[str] = []

    if state.behind > 0:
        message = (
            f"HEAD is {state.behind} commit(s) behind {state.base_ref}; "
            "refresh/rebase before owner acceptance or release evidence"
        )
        if state.mode == "owner-test":
            failures.append(message)
        else:
            warnings.append(message)

    if state.mode == "owner-test" and state.dirty and not allow_dirty:
        failures.append(
            "working tree is dirty; owner acceptance evidence must name an exact committed source identity"
        )
    elif state.dirty:
        warnings.append(
            "working tree is dirty; development/integration may continue, but results must be reported as "
            "dirty_worktree and cannot represent clean owner/release evidence"
        )

    if state.named_local_branches > max_named_branches:
        warnings.append(
            f"{state.named_local_branches} local named branches exceed the advisory budget of "
            f"{max_named_branches}; prefer detached worker worktrees, but do not block active development"
        )

    if state.branch == "main" and state.ahead > 0:
        warnings.append(
            "local main is ahead of origin/main; do not call it the shared main baseline until pushed"
        )

    if state.mode == "start" and state.branch != "(detached)" and state.branch != "main":
        warnings.append(
            "starting parallel worker work from a named feature branch is allowed only for the "
            "primary development/integration owner; child workers should use detached worktrees"
        )

    return failures, warnings


def verify_runtime_health(
    url: str,
    *,
    expected_head: str,
    allow_dirty: bool,
) -> tuple[dict[str, object], list[str]]:
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise GuardError("runtime health verification only accepts loopback http URLs")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=3) as response:
            payload = json.loads(response.read(65536))
    except Exception as exc:
        raise GuardError(f"runtime health unavailable at {url}: {exc}") from exc
    identity = payload.get("build_identity") if isinstance(payload, dict) else None
    if not isinstance(identity, dict):
        raise GuardError("runtime health response has no build_identity object")
    commit = str(identity.get("commit") or "").lower()
    dirty = identity.get("dirty")
    failures: list[str] = []
    if commit != expected_head.lower():
        failures.append(
            f"running OfferU commit {commit or 'unknown'} does not match source HEAD {expected_head}"
        )
    if dirty is True and not allow_dirty:
        failures.append(
            "running OfferU reports dirty=true; owner-test evidence requires a clean runtime identity"
        )
    return {
        "url": url,
        "commit": commit or None,
        "dirty": dirty,
        "build_source": identity.get("build_source"),
    }, failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fail early when OfferU development/testing is based on stale Git state."
    )
    parser.add_argument(
        "--mode",
        choices=("start", "integrate", "owner-test", "pr"),
        default="owner-test",
    )
    parser.add_argument("--base-ref", default="origin/main")
    parser.add_argument("--repo-root")
    parser.add_argument(
        "--no-fetch",
        action="store_true",
        help="Do not refresh origin/main before comparison",
    )
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="Explicitly allow dirty worktree evidence",
    )
    parser.add_argument("--max-named-branches", type=int, default=3)
    parser.add_argument(
        "--runtime-health-url",
        help="Optional loopback /api/health URL; require its build commit to equal HEAD",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        root = discover_root(args.repo_root)
        state = collect_state(
            root,
            mode=args.mode,
            base_ref=args.base_ref,
            do_fetch=not args.no_fetch,
        )
        failures, warnings = evaluate(
            state,
            allow_dirty=args.allow_dirty,
            max_named_branches=max(1, args.max_named_branches),
        )
        runtime = None
        if args.runtime_health_url:
            runtime, runtime_failures = verify_runtime_health(
                args.runtime_health_url,
                expected_head=state.head,
                allow_dirty=args.allow_dirty,
            )
            failures.extend(runtime_failures)
    except GuardError as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"OfferU branch guard: FAIL\n- {exc}", file=sys.stderr)
        return 2

    payload = {
        **asdict(state),
        "runtime": runtime,
        "ok": not failures,
        "failures": failures,
        "warnings": warnings,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        verdict = "PASS" if not failures else "FAIL"
        print(f"OfferU branch guard: {verdict}")
        print(f"mode={state.mode} branch={state.branch} head={state.head[:12]}")
        print(
            f"base={state.base_ref}@{state.base_sha[:12]} "
            f"ahead={state.ahead} behind={state.behind}"
        )
        print(
            f"dirty={str(state.dirty).lower()} "
            f"named_local_branches={state.named_local_branches} "
            f"worktrees={state.worktree_count}"
        )
        if runtime:
            print(
                f"runtime={runtime.get('commit') or 'unknown'} "
                f"dirty={runtime.get('dirty')} source={runtime.get('build_source')}"
            )
        for item in warnings:
            print(f"WARN: {item}")
        for item in failures:
            print(f"FAIL: {item}", file=sys.stderr)

    return 0 if not failures else 2


if __name__ == "__main__":
    raise SystemExit(main())
