"""Real non-resume Registry writes, canonical readback and conservative effects."""
import asyncio
from uuid import uuid4

from sqlalchemy import select, update

from app.models.models import Job, OperationAuditLog, Profile, ProfileTargetRole
from app.services import agent_run_state, profile_operations, proposal_plan_execution as execution
from app.services import proposal_plan_sources as sources, proposal_plan_store as store
from app.services.proposal_plan_builder import build_plan
from app.services.proposal_plan_source_guard import observe_node_sources
from tests.proposal_v2_fixtures import make_db


def test_job_and_default_profile_group_commits_real_registry_effects(tmp_path, monkeypatch):
    async def run():
        database = make_db(tmp_path, monkeypatch)
        await database.start(create_schema=True)
        monkeypatch.setattr(profile_operations, 'async_session', database.sessions)
        monkeypatch.setattr('app.services.ui_approval_capability.accepts_authorization', lambda token: token == 'Bearer synthetic-native-domain')
        async with database.sessions() as db:
            profile = Profile(name='Synthetic domain', is_default=True, headline='Before')
            job = Job(title='Product', company='Fixture', raw_description='Synthetic JD', hash_key=uuid4().hex)
            db.add_all([profile, job])
            await db.commit()
        run_id = f'run_{uuid4().hex[:16]}'
        await agent_run_state.create_agent_run(conversation_id=run_id, goal='Domain review',
            # Trusted Runtime fixture scope, not an Agent Skill acceptance claim.
            mode='proposal_v2_fixture', actions=[], run_id=run_id,
            skill_snapshot={'allowed_tools': ['triage_job', 'update_profile', 'create_target_role']})
        intents = [
            {'id': 'job', 'operation': 'triage_job', 'args': {'job_id': job.id, 'status': 'picked'}, 'summary': 'Select the displayed job'},
            {'id': 'profile', 'operation': 'update_profile', 'args': {'headline': 'Reviewed headline'}, 'summary': 'Revise profile headline'},
            {'id': 'role', 'operation': 'create_target_role', 'args': {'role_name': 'Product', 'fit': 'primary'}, 'summary': 'Add target role'},
        ]
        plan = build_plan(await sources.capture_sources(intents), run_id=run_id, title='Domain review', groups=[
            {'title': 'Select the reviewed job', 'node_ids': ['job']},
            {'title': 'Adopt reviewed positioning', 'node_ids': ['profile', 'role']},
        ])
        await store.create_plan(plan)
        receipts = []
        current = plan
        while pending := [group for group in current['groups'] if group['status'] == 'pending']:
            group = pending[0]
            result = await execution.confirm_group(current['id'], group['id'], plan_digest=current['digest'],
                group_digest=group['digest'], decision_id=f'decision_{uuid4().hex}',
                authorization_source='Bearer synthetic-native-domain', surface='agent_runtime_ui')
            assert result['ok'], result
            assert result['group']['status'] == 'completed'
            receipts.extend(result['receipts'])
            # Committed effects re-snapshot the still-unapproved remainder;
            # never approve its stale parent digest or reuse the old decision.
            current = result.get('successor_plan') or await store.get_plan(current['id'])
        assert len(receipts) == 3
        assert all(receipt['effect_state'] == 'committed' for receipt in receipts)
        async with database.sessions() as db:
            assert (await db.get(Job, job.id)).triage_status == 'picked'
            assert (await db.get(Profile, profile.id)).headline == 'Reviewed headline'
            roles = (await db.execute(select(ProfileTargetRole).where(ProfileTargetRole.profile_id == profile.id))).scalars().all()
            assert [role.role_name for role in roles] == ['Product']
            keys = [receipt['result']['audit_attempt_key'] for receipt in receipts]
            audits = (await db.execute(select(OperationAuditLog).where(OperationAuditLog.idempotency_key.in_(keys)))).scalars().all()
            assert len(audits) == 3 and all(audit.ok and audit.status == 'completed' for audit in audits)
        await database.close()
    asyncio.run(run())


def test_bulk_dml_cannot_claim_no_effect_even_when_readback_did_not_change(tmp_path, monkeypatch):
    async def run():
        database = make_db(tmp_path, monkeypatch)
        await database.start(create_schema=True)
        async with database.sessions() as db:
            job = Job(title='Fixture', company='Fixture', hash_key=uuid4().hex)
            db.add(job)
            await db.commit()
        node = (await sources.capture_sources([{'operation': 'triage_job', 'args': {'job_id': job.id, 'status': 'picked'}}]))[0]
        async with observe_node_sources(node) as guard:
            async with database.sessions() as db:
                await db.execute(update(Job).where(Job.id == -1).values(triage_status='picked'))
                await db.commit()
            evidence = await guard.finish({'ok': False})
        assert evidence['effect_state'] == 'unknown'
        assert not evidence['proven_no_effect']
        assert not evidence['source_evidence']['complete']
        await database.close()
    asyncio.run(run())


def test_workspace_creation_and_batch_adoption_use_same_run_registry_receipts(tmp_path, monkeypatch):
    async def run():
        from unittest.mock import AsyncMock
        from tests.proposal_v2_fixtures import seed_reviewable_resume_proposal
        from app.services import resume_workspace
        from app.models.models import ResumeOptimizationProposal, ResumeSection
        database = make_db(tmp_path, monkeypatch)
        await database.start(create_schema=True)
        monkeypatch.setattr(resume_workspace, 'get_pre_application_state', AsyncMock(return_value={'stage': 'resume_proposal_ready'}))
        monkeypatch.setattr('app.services.ui_approval_capability.accepts_authorization', lambda value: value == 'Bearer synthetic-workspace-native')
        seed = await seed_reviewable_resume_proposal(database, uuid4().hex)
        run_id = f'run_{uuid4().hex[:16]}'
        await agent_run_state.create_agent_run(conversation_id=run_id, goal='Prepare and adopt the reviewed resume',
            mode='resume_workflow', skill_id='tailor_resume', actions=[], run_id=run_id,
            llm_runtime={'runtime': 'external_cli', 'host': 'synthetic-test'})
        async def approve(intent):
            plan = build_plan(await sources.capture_sources([intent]), run_id=run_id, title=intent['summary'])
            await store.create_plan(plan)
            group = plan['groups'][0]
            result = await execution.confirm_group(plan['id'], group['id'], plan_digest=plan['digest'], group_digest=group['digest'],
                decision_id=f'decision_{uuid4().hex}', authorization_source='Bearer synthetic-workspace-native', surface='agent_runtime_ui')
            assert result['ok'], result
            assert len(result['receipts']) == 1 and result['receipts'][0]['effect_state'] == 'committed'
            return result, group['nodes'][0]
        created, first = await approve({'operation': 'ensure_resume_workspace',
            'args': {'job_id': seed['job_id'], 'proposal_id': seed['proposal_id'], 'reference_resume_id': seed['master_resume_id']},
            'summary': 'Create the reviewed Job Resume Workspace'})
        proof = created['receipts'][0]['result']['source_evidence']['workspace_effect']
        assert proof['mode'] == 'created' and proof['verified']
        resume_id = proof['workspace_id']
        async with database.sessions() as db:
            proposal = await db.get(ResumeOptimizationProposal, seed['proposal_id'])
            assert proposal.workspace_resume_id == resume_id and proposal.item_reviews_json == {}
        adopted, second = await approve({'operation': 'review_resume_proposal_items',
            'args': {'proposal_id': seed['proposal_id'], 'resume_id': resume_id, 'change_ids': [seed['change_id']], 'action': 'accept'},
            'summary': 'Adopt the displayed evidence-backed change'})
        assert adopted['plan']['run_id'] == created['plan']['run_id'] == run_id
        async with database.sessions() as db:
            proposal = await db.get(ResumeOptimizationProposal, seed['proposal_id'])
            sections = (await db.execute(select(ResumeSection).where(ResumeSection.resume_id == resume_id))).scalars().all()
            assert proposal.item_reviews_json[seed['change_id']]['action'] == 'accept'
            assert any('new evidence' in str(section.content_json) for section in sections)
            keys = [first['idempotency_key'], second['idempotency_key']]
            audits = (await db.execute(select(OperationAuditLog).where(OperationAuditLog.idempotency_key.in_(keys)))).scalars().all()
            assert len(audits) == 2 and all(item.ok for item in audits)
        await database.close()
    asyncio.run(run())
