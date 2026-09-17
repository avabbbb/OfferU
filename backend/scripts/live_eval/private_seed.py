"""Repo-external Private Eval seed creation and label templates."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.security_redaction import redact_secret_text
from scripts.live_eval.isolation import clone_database, table_names, write_json


PROJECT_ROOT = Path(__file__).resolve().parents[3]
CURATION_STATUS = "NEEDS_USER_CURATION"
PROVENANCE_COLUMNS = {"source", "batch_id", "created_by", "updated_by", "origin"}
DROP_MARKERS = ("offeru-demo", "demo", "fixture", "synthetic", "test")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _table_counts(db_path: Path) -> dict[str, int]:
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        counts: dict[str, int] = {}
        for name in table_names(db_path):
            safe_name = name.replace('"', '""')
            counts[name] = int(
                connection.execute(f'SELECT COUNT(*) FROM "{safe_name}"').fetchone()[0]
            )
        return counts
    finally:
        connection.close()


def _integrity_check(db_path: Path) -> str:
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        return str(connection.execute("PRAGMA integrity_check").fetchone()[0])
    finally:
        connection.close()


def _drop_candidate_counts(db_path: Path) -> dict[str, int]:
    connection = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        result: dict[str, int] = {}
        for table in table_names(db_path):
            safe_table = table.replace('"', '""')
            columns = {
                str(row[1])
                for row in connection.execute(f'PRAGMA table_info("{safe_table}")').fetchall()
            }
            condition, parameters = _candidate_filter(columns)
            if not condition:
                continue
            count = int(
                connection.execute(
                    f'SELECT COUNT(*) FROM "{safe_table}" WHERE {condition}',
                    parameters,
                ).fetchone()[0]
            )
            if count:
                result[table] = count
        return result
    finally:
        connection.close()


def _candidate_filter(columns: set[str]) -> tuple[str, list[str]]:
    clauses: list[str] = []
    parameters: list[str] = []
    for column in sorted(columns & PROVENANCE_COLUMNS):
        safe_column = column.replace('"', '""')
        for marker in DROP_MARKERS:
            value = f'LOWER(TRIM(COALESCE("{safe_column}", "")))'
            clauses.extend((
                f"{value} = ?",
                f"{value} LIKE ?",
                f"{value} LIKE ? ESCAPE '\\'",
                f"{value} LIKE ?",
                f"{value} LIKE ? ESCAPE '\\'",
                f"{value} LIKE ?",
                f"{value} LIKE ? ESCAPE '\\'",
            ))
            parameters.extend((
                marker,
                f"{marker}-%",
                f"{marker}\\_%",
                f"%-{marker}",
                f"%\\_{marker}",
                f"%-{marker}-%",
                f"%\\_{marker}\\_%",
            ))
    return " OR ".join(clauses), parameters


def _write_once(path: Path, payload: Any) -> None:
    if not path.exists():
        write_json(path, payload)


def _skill_route_template() -> dict[str, Any]:
    categories = (
        ["core"] * 18
        + ["ambiguous"] * 10
        + ["cross_domain"] * 8
        + ["no_tool_or_clarify"] * 6
        + ["safety"] * 4
        + ["missing_context_or_failure"] * 4
    )
    return {
        "private": True,
        "schema_version": 1,
        "instructions": "Fill prompts with natural user language. Do not include Skill IDs or Operation names.",
        "cases": [
            {
                "case_id": f"SR{index:02d}",
                "category": category,
                "prompt": "",
                "expected_capability": "",
                "acceptable_capabilities": [],
                "expected_outcome": "",
            }
            for index, category in enumerate(categories, start=1)
        ],
    }


def _ground_truth_template() -> dict[str, Any]:
    return {
        "private": True,
        "schema_version": 1,
        "jobs": [],
        "resume": {"supported_facts": [], "unsupported_facts": [], "preferred_wording": []},
        "applications": [],
        "interviews": [],
        "preferences": {},
        "notes": "Use stable OfferU record IDs. Keep Agent output separate from these labels.",
    }


def _human_ratings_template() -> dict[str, Any]:
    return {
        "private": True,
        "schema_version": 1,
        "ratings": [],
        "dimensions": {
            "useful": {"min": 1, "max": 5},
            "grounded": {"min": 1, "max": 5},
            "would_use": ["yes", "no"],
        },
    }


def _private_real_user_template() -> dict[str, Any]:
    journeys = (
        "career_context",
        "job_fit",
        "role_intelligence",
        "career_evidence_gap",
        "resume_tailoring",
        "resume_fact_gate",
        "stale_proposal",
        "today",
        "pipeline",
        "application_progress",
        "boss_email_signal_fusion",
        "interview_preparation",
        "interview_follow_up",
        "debrief",
        "learning_candidate",
        "mutation_approval",
        "external_submit_refusal",
        "external_message_refusal",
        "failure_recovery",
        "cross_domain_daily_review",
    )
    return {
        "private": True,
        "schema_version": 1,
        "cases": [
            {
                "case_id": f"PR{index:02d}",
                "journey": journey,
                "user_turns": [],
                "outcome_criteria": [],
                "protected_records": [],
                "forbidden_operations": [],
                "forbidden_side_effects": [],
                "ground_truth_refs": [],
                "human_rating_required": journey in {
                    "job_fit",
                    "role_intelligence",
                    "resume_tailoring",
                    "interview_preparation",
                    "debrief",
                },
            }
            for index, journey in enumerate(journeys, start=1)
        ],
    }


def create_private_seed(source_db: Path, workspace: Path) -> dict[str, Any]:
    """Create an immutable private seed snapshot without exposing row content."""

    source = Path(source_db).resolve()
    root = Path(workspace).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Private Eval source database not found: {source}")
    if root == PROJECT_ROOT or PROJECT_ROOT in root.parents:
        raise ValueError("Private Eval workspace must be outside the Git repository")

    root.mkdir(parents=True, exist_ok=True)
    source_hash_before = _sha256(source)
    seed_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    seed_dir = root / "seeds" / seed_id
    seed_path = seed_dir / "private_seed.db"
    clone_database(source, seed_path)
    source_hash_after = _sha256(source)
    if source_hash_before != source_hash_after:
        raise RuntimeError("Source database changed while creating the Private Eval seed")

    integrity = _integrity_check(seed_path)
    if integrity != "ok":
        raise RuntimeError(f"Private Eval seed integrity check failed: {integrity}")

    counts = _table_counts(seed_path)
    drop_candidates = _drop_candidate_counts(seed_path)
    manifest = {
        "schema_version": 1,
        "private": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": {"filename": source.name, "sha256": source_hash_before},
        "seed": {"filename": seed_path.name, "sha256": _sha256(seed_path)},
        "integrity_check": integrity,
        "curation_status": CURATION_STATUS,
        "table_counts": counts,
        "classification": {
            "UNREVIEWED": [name for name in counts if counts[name] > 0],
            "KEEP": [],
            "DROP_FROM_PRIVATE_SEED": [],
            "DROP_CANDIDATES_NOT_APPLIED": drop_candidates,
            "note": "No row is removed until the user reviews private labels and curation candidates.",
        },
    }
    manifest_path = seed_dir / "private_seed_manifest.json"
    write_json(manifest_path, manifest)

    template_paths = (
        root / "ground_truth.template.json",
        root / "skill_route_50.template.json",
        root / "human_ratings.template.json",
        root / "private_real_user_20.template.json",
    )
    _write_once(template_paths[0], _ground_truth_template())
    _write_once(template_paths[1], _skill_route_template())
    _write_once(template_paths[2], _human_ratings_template())
    _write_once(template_paths[3], _private_real_user_template())
    return {
        "seed_path": str(seed_path),
        "manifest_path": str(manifest_path),
        "template_paths": [str(path) for path in template_paths],
        "integrity_check": integrity,
        "curation_status": CURATION_STATUS,
        "source_unchanged": True,
        "seed_hash": manifest["seed"]["sha256"],
    }


def curate_private_seed(raw_seed: Path) -> dict[str, Any]:
    """Create a second seed, removing only unreferenced provenance-marked rows."""

    source = Path(raw_seed).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Private Eval raw seed not found: {source}")
    source_hash_before = _sha256(source)
    curated_dir = source.parent / "curated" / datetime.now(timezone.utc).strftime(
        "%Y%m%dT%H%M%S%fZ"
    )
    curated_path = curated_dir / "private_seed_curated.db"
    if curated_path.exists():
        raise FileExistsError(f"Curated seed already exists: {curated_path}")
    clone_database(source, curated_path)

    removed: dict[str, int] = {}
    retained: dict[str, int] = {}
    connection = sqlite3.connect(str(curated_path))
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        tables = table_names(curated_path)
        inbound: dict[str, list[tuple[str, str, str]]] = {table: [] for table in tables}
        for child in tables:
            safe_child = child.replace('"', '""')
            for foreign_key in connection.execute(f'PRAGMA foreign_key_list("{safe_child}")'):
                parent = str(foreign_key[2])
                if parent in inbound:
                    inbound[parent].append(
                        (child, str(foreign_key[3]), str(foreign_key[6]).upper())
                    )

        for table in tables:
            safe_table = table.replace('"', '""')
            info = connection.execute(f'PRAGMA table_info("{safe_table}")').fetchall()
            columns = {str(row[1]) for row in info}
            condition, parameters = _candidate_filter(columns)
            if not condition:
                continue
            primary_keys = [str(row[1]) for row in info if int(row[5] or 0) == 1]
            candidate_count = int(
                connection.execute(
                    f'SELECT COUNT(*) FROM "{safe_table}" WHERE {condition}', parameters
                ).fetchone()[0]
            )
            if not candidate_count:
                continue
            if len(primary_keys) != 1:
                retained[table] = candidate_count
                continue
            primary_key = primary_keys[0]
            safe_primary_key = primary_key.replace('"', '""')
            candidate_ids = [
                row[0]
                for row in connection.execute(
                    f'SELECT "{safe_primary_key}" FROM "{safe_table}" WHERE {condition}',
                    parameters,
                ).fetchall()
            ]
            deletable: list[Any] = []
            for candidate_id in candidate_ids:
                blocked = False
                for child, from_column, on_delete in inbound.get(table, []):
                    if on_delete not in {"NO ACTION", "RESTRICT"}:
                        continue
                    safe_child = child.replace('"', '""')
                    safe_from = from_column.replace('"', '""')
                    reference = connection.execute(
                        f'SELECT 1 FROM "{safe_child}" WHERE "{safe_from}" = ? LIMIT 1',
                        (candidate_id,),
                    ).fetchone()
                    if reference:
                        blocked = True
                        break
                if not blocked:
                    deletable.append(candidate_id)
            for candidate_id in deletable:
                connection.execute(
                    f'DELETE FROM "{safe_table}" WHERE "{safe_primary_key}" = ?',
                    (candidate_id,),
                )
            if deletable:
                removed[table] = len(deletable)
            if len(deletable) != len(candidate_ids):
                retained[table] = len(candidate_ids) - len(deletable)

        foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_key_errors:
            connection.rollback()
            raise RuntimeError("Curated seed failed foreign key validation")
        connection.commit()
    finally:
        connection.close()

    integrity = _integrity_check(curated_path)
    if integrity != "ok":
        raise RuntimeError(f"Curated seed integrity check failed: {integrity}")
    if _sha256(source) != source_hash_before:
        raise RuntimeError("Raw Private Eval seed changed during curation")

    manifest = {
        "schema_version": 1,
        "private": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "raw_seed_sha256": source_hash_before,
        "curated_seed_sha256": _sha256(curated_path),
        "integrity_check": integrity,
        "foreign_key_violations": 0,
        "curation_status": "CURATED_CONSERVATIVE",
        "removed": removed,
        "retained_due_references": retained,
        "table_counts": _table_counts(curated_path),
    }
    manifest_path = curated_dir / "curated_seed_manifest.json"
    write_json(manifest_path, manifest)
    return {
        "seed_path": str(curated_path),
        "manifest_path": str(manifest_path),
        "seed_hash": manifest["curated_seed_sha256"],
        "integrity_check": integrity,
        "removed": removed,
        "retained_due_references": retained,
    }


def extract_private_prompt_candidates(
    seed_db: Path,
    output_path: Path,
    *,
    limit: int = 200,
) -> dict[str, Any]:
    """Extract distinct user-shaped Agent Run goals into a private, secret-redacted file."""

    source = Path(seed_db).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"Private Eval seed not found: {source}")
    source_hash_before = _sha256(source)
    connection = sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)
    try:
        names = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "agent_runs" not in names:
            goals: list[str] = []
        else:
            goals = [
                str(row[0] or "").strip()
                for row in connection.execute(
                    "SELECT goal FROM agent_runs WHERE goal IS NOT NULL ORDER BY created_at DESC"
                    if "created_at" in {
                        str(item[1])
                        for item in connection.execute('PRAGMA table_info("agent_runs")')
                    }
                    else "SELECT goal FROM agent_runs WHERE goal IS NOT NULL"
                ).fetchall()
            ]
    finally:
        connection.close()

    unique: list[str] = []
    seen: set[str] = set()
    for goal in goals:
        if len(goal) < 4 or goal.startswith("Execute OfferU Operation "):
            continue
        redacted = redact_secret_text(goal, max_length=1000).strip()
        if not redacted or redacted in seen:
            continue
        seen.add(redacted)
        unique.append(redacted)
        if len(unique) >= max(1, limit):
            break

    payload = {
        "private": True,
        "schema_version": 1,
        "source_seed_sha256": source_hash_before,
        "candidates": [
            {
                "candidate_id": f"PC{index:03d}",
                "prompt": prompt,
                "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
                "selected_for_skill_route": False,
            }
            for index, prompt in enumerate(unique, start=1)
        ],
    }
    write_json(Path(output_path), payload)
    if _sha256(source) != source_hash_before:
        raise RuntimeError("Private Eval seed changed while extracting prompt candidates")
    return {
        "output_path": str(Path(output_path).resolve()),
        "candidate_count": len(unique),
        "source_unchanged": True,
    }


__all__ = [
    "CURATION_STATUS",
    "create_private_seed",
    "curate_private_seed",
    "extract_private_prompt_candidates",
]
