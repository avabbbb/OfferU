import asyncio
import base64
from io import BytesIO
from uuid import uuid4

import pytest
from PIL import Image

from app.services import agent_run_state, resume_design
from app.services import proposal_plan_execution as execution, proposal_plan_store as store
from app.services.agent_skill_registry import resolve_skill
from app.services.proposal_plan_preparation import prepare_proposal_plan
from tests.proposal_v2_fixtures import make_db, seed_resume


@pytest.mark.parametrize("tamper", [False, True])
def test_design_receipt_verifies_image_bytes_and_never_replays(tmp_path, monkeypatch, tamper):
    async def run():
        database = make_db(tmp_path, monkeypatch)
        await database.start(create_schema=True)
        try:
            monkeypatch.setattr(resume_design, "async_session", database.sessions)
            monkeypatch.setattr(resume_design, "runtime_uploads_dir", lambda folder: tmp_path / "uploads" / folder)
            monkeypatch.setattr("app.services.ui_approval_capability.accepts_authorization", lambda token: token == "Bearer synthetic-design")
            fixture = await seed_resume(database)
            image = BytesIO()
            Image.new("RGB", (20, 30), "navy").save(image, "PNG")
            skill = resolve_skill("resume_export")
            run_id = f"run_{uuid4().hex[:16]}"
            await agent_run_state.create_agent_run(conversation_id=run_id, goal="Review design", mode="proposal_v2_fixture",
                skill_id=skill.id, skill_snapshot=skill.summary(), actions=[], run_id=run_id)
            prepared = await prepare_proposal_plan(run_id=run_id, title="Review design", intents=[{
                "operation": "update_resume_design", "args": {"resume_id": fixture["resume_id"], "expected_revision": 0,
                    "style_config": {"accentColorHex": "#7c3aed"},
                    "photo": {"content_type": "image/png", "content_b64": base64.b64encode(image.getvalue()).decode()}},
                "summary": "Adopt reviewed photo and design"}], groups=[])
            plan = prepared["plan"]
            group = plan["groups"][0]
            if tamper:
                from app.services import proposal_plan_design_effects
                verify = proposal_plan_design_effects.verify_design_effect
                def corrupt(node, observed, guard):
                    for path in (tmp_path / "uploads").rglob("*.png"):
                        path.write_bytes(b"corrupt")
                    return verify(node, observed, guard)
                monkeypatch.setattr(proposal_plan_design_effects, "verify_design_effect", corrupt)
            decision_id = f"decision_{uuid4().hex}"
            kwargs = dict(plan_digest=plan["digest"], group_digest=group["digest"], decision_id=decision_id,
                          authorization_source="Bearer synthetic-design", surface="agent_runtime_ui")
            first = await execution.confirm_group(plan["id"], group["id"], **kwargs)
            assert first["ok"] is (not tamper), first
            receipt = first["receipts"][0]
            assert receipt["effect_state"] == ("partial" if tamper else "committed")
            if not tamper:
                proof = receipt["result"]["source_evidence"]
                assert proof["adapter"] == "proposal-plan.resume-design.v1"
                assert len(proof["files"]) == 1
            await execution.confirm_group(plan["id"], group["id"], **kwargs)
            assert len(list((tmp_path / "uploads").rglob("*.png"))) == 1
            persisted = await store.get_plan(plan["id"])
            assert persisted["groups"][0]["nodes"][0]["attempt_count"] == 1
        finally:
            await database.close()
    asyncio.run(run())
