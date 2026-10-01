import asyncio
import base64
from contextlib import AsyncExitStack
from io import BytesIO
from unittest.mock import patch

from PIL import Image
import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import Resume, ResumeSection, ResumeVersion, OperationAuditLog
from app.services import resume_design as design, resume_route_operations as legacy


def image_payload():
    output = BytesIO()
    Image.new("RGB", (20, 30), "navy").save(output, "PNG")
    return {"content_type": "image/png", "content_b64": base64.b64encode(output.getvalue()).decode()}


async def scenario(tmp_path, callback):
    engine = create_async_engine(f"sqlite+aiosqlite:///{(tmp_path / 'design.db').as_posix()}")
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            resume = Resume(user_name="测试", title="原始简历", summary="未经修改的正文", workspace_revision=0,
                            style_config={"template": "reference", "bodySize": "10.5"}, contact_json={"email": "fixture@example.test"})
            db.add(resume)
            await db.flush()
            db.add(ResumeSection(resume_id=resume.id, section_type="custom", title="经历", content_json=[{"description": "<p>原始证据</p>"}]))
            await db.commit()
            resume_id = resume.id
        async with AsyncExitStack() as stack:
            for module in ("app.services.resume_design", "app.services.resume_route_operations", "app.ops", "app.services.agent_run_state", "app.services.agent_run_coordinator"):
                stack.enter_context(patch(f"{module}.async_session", sessions))
            stack.enter_context(patch.object(design, "runtime_uploads_dir", lambda folder: tmp_path / "uploads" / folder))
            await callback(sessions, resume_id)
    finally:
        await engine.dispose()


def test_design_schema_cannot_rewrite_facts_or_load_arbitrary_urls():
    for data in ({"summary": "虚构经历"}, {"style_config": {"content": "虚构经历"}},
                 {"style_config": {"bodySize": float("nan")}}, {"style_config": {"accentColorHex": "red;url(http://x)"}},
                 {"photo": {"url": "http://example.com/photo.png"}}, {"photo": image_payload(), "remove_photo": True}):
        with pytest.raises(ValidationError):
            design.ResumeDesignInput(resume_id=1, expected_revision=0, **data)


def test_images_design_versions_restore_and_stale_editor(tmp_path):
    async def check(sessions, resume_id):
        result = await design.update_resume_design(resume_id, 0, {"accentColorHex": "#7c3aed", "bodySize": 10.75}, image_payload(), image_payload())
        assert result["workspace_revision"] == 1
        assert result["summary"] == "未经修改的正文"
        assert result["contact_json"]["email"] == "fixture@example.test"
        assert result["sections"][0]["content_json"] == [{"description": "<p>原始证据</p>"}]
        assert len(list((tmp_path / "uploads").rglob("*.png"))) == 2
        with pytest.raises(ValueError, match="已被修改"):
            await design.update_resume_design(resume_id, 0, {"bodySize": 12})
        with pytest.raises(ValueError, match="已被修改"):
            await legacy.update_resume_record(resume_id, {"expected_revision": 0, "summary": "旧编辑器内容"})
        async with sessions() as db:
            versions = (await db.execute(select(ResumeVersion).order_by(ResumeVersion.version_number))).scalars().all()
        assert len(versions) == 2
        assert versions[0].content_snapshot["resume"]["style_config"]["bodySize"] == "10.5"
        assert versions[1].content_snapshot["resume"]["photo_url"] == result["photo_url"]
        duplicate = await design.update_resume_design(resume_id, 1, {"bodySize": 10.75})
        assert duplicate["duplicate"] and duplicate["workspace_revision"] == 1
        await legacy.restore_resume_version_record(resume_id, versions[0].id)
        async with sessions() as db:
            restored = await db.get(Resume, resume_id)
            assert restored.style_config["bodySize"] == "10.5"
            assert not restored.photo_url
            assert restored.workspace_revision == 2
        # Old image files remain available to the saved version.
        assert len(list((tmp_path / "uploads").rglob("*.png"))) == 2
    asyncio.run(scenario(tmp_path, check))


def test_invalid_image_or_transaction_failure_leaves_no_partial_change(tmp_path):
    async def check(sessions, resume_id):
        with pytest.raises(ValueError):
            await design.update_resume_design(resume_id, 0, photo={"content_type": "image/png", "content_b64": base64.b64encode(b"not an image").decode()})
        original = design.create_version_snapshot
        calls = 0
        async def fail_after_upload(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("fixture failure after upload")
            return await original(*args, **kwargs)
        with patch.object(design, "create_version_snapshot", fail_after_upload):
            with pytest.raises(RuntimeError, match="fixture failure"):
                await design.update_resume_design(resume_id, 0, photo=image_payload())
        assert not list((tmp_path / "uploads").rglob("*.png"))
        async with sessions() as db:
            resume = await db.get(Resume, resume_id)
            assert resume.workspace_revision == 0 and not resume.photo_url
            assert not (await db.execute(select(ResumeVersion))).scalars().all()
    asyncio.run(scenario(tmp_path, check))


def test_concurrent_designs_cannot_overwrite_each_other(tmp_path):
    async def check(sessions, resume_id):
        results = await asyncio.gather(design.update_resume_design(resume_id, 0, {"bodySize": 11}),
                                       design.update_resume_design(resume_id, 0, {"bodySize": 12}), return_exceptions=True)
        assert sum(isinstance(result, dict) for result in results) == 1
        assert sum(isinstance(result, ValueError) for result in results) == 1
        async with sessions() as db:
            assert (await db.get(Resume, resume_id)).workspace_revision == 1
            assert len((await db.execute(select(ResumeVersion))).scalars().all()) == 2
    asyncio.run(scenario(tmp_path, check))


def test_proposal_is_pending_then_confirmed_once_with_redacted_audit(tmp_path):
    """Fixture confirmation boundary test; this is not a human/Agent-native E2E."""
    from app.services.operation_projection import execute_or_propose_operation, confirm_operation_proposal
    from app.cli import _manifest
    assert "update_resume_design" in {op["name"] for op in _manifest(skill="resume_export")["operations"]}
    async def check(sessions, resume_id):
        proposed = await execute_or_propose_operation("update_resume_design", {"resume_id": resume_id, "expected_revision": 0,
            "style_config": {"accentColorHex": "#7c3aed"}, "photo": image_payload()}, surface="cli")
        assert proposed["ok"], proposed
        item = proposed["outputs"]["proposal"]
        async with sessions() as db:
            assert (await db.get(Resume, resume_id)).workspace_revision == 0
        assert not list((tmp_path / "uploads").rglob("*.png"))
        first = await confirm_operation_proposal(item["run_id"], action_id=item["action_id"], surface="agent_runtime_ui")
        assert first["ok"], first
        second = await confirm_operation_proposal(item["run_id"], action_id=item["action_id"], surface="agent_runtime_ui")
        assert second["ok"] and not second["tool_calls"]
        async with sessions() as db:
            assert (await db.get(Resume, resume_id)).workspace_revision == 1
            audits = (await db.execute(select(OperationAuditLog))).scalars().all()
            assert audits
            assert image_payload()["content_b64"] not in repr([a.__dict__ for a in audits])
        assert len(list((tmp_path / "uploads").rglob("*.png"))) == 1
    asyncio.run(scenario(tmp_path, check))
