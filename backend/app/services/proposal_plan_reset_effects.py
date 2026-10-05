"""Read back an independently authorized fresh reset before recording success."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from sqlalchemy import text

from app.services import data_safety, local_data_reset as reset
from app.services.proposal_plan_builder import PlanValidationError

ADAPTER = "proposal-plan.clean-reset.v1"


async def verify_reset_effect(node: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    outputs = result.get("outputs") or {}
    backup = outputs.get("backup") or {}
    if node.get("operation") != "reset_local_business_data" or not result.get("ok") or not outputs.get("file_cleanup_complete"):
        raise PlanValidationError("Reset has no successful Registry result")
    root = reset._preflight_reset_paths()
    reset._assert_reset_database_root(root)
    layout = data_safety._runtime_layout()
    archive = data_safety._archive_path(layout, str(backup.get("backup_id") or ""))
    manifest, _ = await asyncio.to_thread(data_safety._validated_archive, archive, expected_backup_id=backup["backup_id"])
    if manifest.get("reason") != "pre_reset" or await asyncio.to_thread(data_safety._sha256_file, archive) != backup.get("archive_sha256"):
        raise PlanValidationError("Reset backup no longer matches the completed action")
    retained = {
        "agent_runs": 1, "job_search_tasks": 1, "profiles": 1,
        "application_tables": 2, "batches": 1,
        "proposal_plans": 1, "proposal_confirmation_groups": 1,
        "proposal_operation_nodes": 1, "proposal_confirmation_decisions": 1,
    }
    async with reset.async_session() as db:
        names, _ = await reset._managed_table_names(db)
        for name in names:
            if name in reset.PRESERVED_TABLES:
                continue
            count = (await db.execute(text(f"SELECT COUNT(*) FROM {reset._quote_identifier(name)}"))).scalar_one()
            if count != retained.get(name, 0):
                raise PlanValidationError(f"Reset readback found remaining data in {name}")
        from app.models.models import Profile
        profile = await db.get(Profile, outputs.get("default_profile_id"))
        if profile is None or profile.name != "默认档案" or profile.email:
            raise PlanValidationError("Reset did not create the empty default Profile")
    for name in reset._DATA_DIRECTORIES:
        if any((root / "data" / name).iterdir()):
            raise PlanValidationError("Reset readback found an old runtime artifact")
    if any((root / "uploads").iterdir()):
        raise PlanValidationError("Reset readback found an old upload")
    for name, expected in {**reset._HARNESS_FILES, **reset._RESET_EPHEMERAL_FILES}.items():
        if json.loads((root / "data" / name).read_text(encoding="utf-8")) != expected:
            raise PlanValidationError("Reset readback found old conversation or memory data")
    indexes = outputs.get("cleared_indexes") or {}
    if indexes.get("state") != "not_applicable":
        from app.services.semantic_search import get_semantic_search
        if not await get_semantic_search().career_indexes_empty():
            raise PlanValidationError("Reset readback found old Career search data")
    else:
        from app.config import get_settings
        if str(get_settings().qdrant_host or "").strip():
            raise PlanValidationError("Configured Career index was not verified")
    return {"effect_state": "committed", "proven_no_effect": False, "source_evidence": {
        "before_versions": {}, "after_versions": {}, "effects": [],
        "verified": True, "complete": True, "adapter": ADAPTER,
        "reset_effect": {"backup_id": backup["backup_id"], "database_verified": True,
                         "files_verified": True, "indexes_verified": True},
    }}
