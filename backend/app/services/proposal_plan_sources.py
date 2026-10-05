"""Read canonical source versions and concrete changes before sealing a plan."""
from __future__ import annotations

import copy
from datetime import date, datetime
from typing import Any

from sqlalchemy import select

from app.database import async_session
from app.models.models import Job, Pool, Profile, ProfileSection, ProfileTargetRole, Resume, ResumeSection, ResumeVersion, ResumeOptimizationProposal, MemoryProposal
from app.services.proposal_plan_builder import PlanValidationError, canonical_digest, _normalize


def _row(row: Any) -> dict[str, Any]:
    return {column.name: value.isoformat() if isinstance(value := getattr(row, column.name), (datetime, date)) else value
            for column in row.__table__.columns if column.name not in {"created_at", "updated_at"}}


async def _source(db: Any, kind: str, identity: str) -> Any:
    model = {"job": Job, "pool": Pool, "profile": Profile, "resume": Resume, "proposal": ResumeOptimizationProposal, "memory_proposal": MemoryProposal}.get(kind)
    if model is None:
        raise PlanValidationError("Unknown source version kind")
    row = await db.get(model, identity if kind == "proposal" else int(identity))
    if row is None:
        raise PlanValidationError(f"Source {kind}:{identity} is missing")
    material = _row(row)
    if kind in {"profile", "resume"}:
        section_model = ProfileSection if kind == "profile" else ResumeSection
        parent = section_model.profile_id if kind == "profile" else section_model.resume_id
        sections = (await db.execute(select(section_model).where(parent == int(identity)).order_by(section_model.id))).scalars().all()
        material["sections"] = [_row(section) for section in sections]
        related_model = ProfileTargetRole if kind == "profile" else ResumeVersion
        related_parent = related_model.profile_id if kind == "profile" else related_model.resume_id
        related = (await db.execute(select(related_model).where(related_parent == int(identity)).order_by(related_model.id))).scalars().all()
        material["roles" if kind == "profile" else "versions"] = [_row(item) for item in related]
    return material


async def capture_sources(intents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Model-provided before/diff cannot overwrite an authoritative resume diff."""
    prepared = copy.deepcopy(intents)
    async with async_session() as db:
        for intent in prepared:
            specific_targets = []
            _, args = _normalize(str(intent.get("operation") or ""), intent.get("args") or {})
            intent["args"] = args
            identities = {kind: str(args[f"{kind}_id"]) for kind in ("job", "profile", "resume", "proposal") if args.get(f"{kind}_id") is not None}
            if args.get("pool_id") and int(args["pool_id"]) > 0:
                identities["pool"] = str(args["pool_id"])
            workspace_references = {}
            if intent["operation"] == "ensure_resume_workspace":
                proposal = await db.get(ResumeOptimizationProposal, args["proposal_id"]) if args.get("proposal_id") else None
                if proposal and proposal.job_id != args["job_id"]:
                    raise PlanValidationError("Workspace proposal belongs to another Job")
                existing = await db.get(Resume, proposal.workspace_resume_id) if proposal and proposal.workspace_resume_id else None
                if existing is None:
                    existing = (await db.execute(select(Resume).where(Resume.target_job_id == args["job_id"], Resume.source_mode == "job_tailored_workspace").order_by(Resume.updated_at.desc(), Resume.id.desc()))).scalars().first()
                if existing is None and proposal and proposal.accepted_resume_id:
                    existing = await db.get(Resume, proposal.accepted_resume_id)
                profile_id = existing.source_profile_id if existing else proposal.profile_id if proposal else None
                profile = await db.get(Profile, profile_id) if profile_id else (await db.execute(select(Profile).order_by(Profile.is_default.desc(), Profile.updated_at.desc()))).scalars().first()
                if profile is None:
                    raise PlanValidationError("Workspace Profile is missing")
                identities["profile"] = str(profile.id)
                reference_id = existing.source_resume_id if existing else (proposal.reference_resume_id if proposal and proposal.reference_resume_id else args.get("reference_resume_id"))
                master = await db.get(Resume, reference_id) if reference_id else None
                if reference_id and master is None:
                    raise PlanValidationError("Workspace reference Resume is missing")
                if master is None and existing is None:
                    master = (await db.execute(select(Resume).where(Resume.source_mode != "job_tailored_workspace").order_by(Resume.is_primary.desc(), Resume.updated_at.desc(), Resume.id.desc()))).scalars().first()
                if existing:
                    workspace_references[f"resume:{existing.id}"] = await _source(db, "resume", str(existing.id))
                if master:
                    workspace_references[f"resume:{master.id}"] = await _source(db, "resume", str(master.id))
                before = {"workspace_resume_id": existing.id if existing else None, "reference_resume_id": master.id if master else None,
                          "profile_id": profile.id, "job_id": args["job_id"]}
                if existing:
                    sections = (await _source(db, "resume", str(existing.id)))["sections"]
                elif proposal and proposal.original_rows_json:
                    sections = copy.deepcopy(proposal.original_rows_json)
                elif master:
                    sections = workspace_references[f"resume:{master.id}"]["sections"]
                else:
                    sections = [{"section_type": value, "title": title, "content_json": []} for value, title in [("education", "教育经历"), ("workExperiences", "工作经历"), ("skills", "技能")]]
                intent["display"] = {"before": before, "after": {**before, "action": "复用岗位简历工作区" if existing else "创建岗位简历工作区", "sections": sections},
                                     "rationale": str(intent.get("summary") or "")}
            if intent.get("operation") in {"update_profile", "create_target_role", "delete_target_role"}:
                profile = (await db.execute(select(Profile).where(Profile.is_default.is_(True)))).scalar_one_or_none()
                if profile is None:
                    raise PlanValidationError("The canonical default Profile is missing")
                identities["profile"] = str(profile.id)
                if intent["operation"] == "update_profile":
                    current = _row(profile)
                    after = copy.deepcopy(args)
                    if "base_info_json" in after:
                        from app.services.profile_schema import normalize_base_info_payload
                        after["base_info_json"] = normalize_base_info_payload(after["base_info_json"])
                        archive = after["base_info_json"].get("personal_archive") or {}
                        if isinstance(archive, dict) and archive.get("schemaVersion") == "personal.archive.v1":
                            raise PlanValidationError("Profile archive replacement needs its own complete change preview and effect adapter")
                    intent["display"] = {"before": {key: current.get(key) for key in args}, "after": after,
                                         "rationale": str(intent.get("summary") or "")}
                elif intent["operation"] == "create_target_role":
                    roles = (await db.execute(select(ProfileTargetRole).where(ProfileTargetRole.profile_id == profile.id).order_by(ProfileTargetRole.id))).scalars().all()
                    before = [{"目标岗位": role.role_name, "级别": role.role_level, "定位": role.fit} for role in roles]
                    intent["display"] = {"before": before, "after": [*before, {"目标岗位": args["role_name"].strip(),
                        "级别": args.get("role_level", ""), "定位": args.get("fit", "primary").strip().lower()}],
                        "rationale": str(intent.get("summary") or "")}
                elif intent["operation"] == "delete_target_role":
                    role = await db.get(ProfileTargetRole, args.get("role_id"))
                    if role is None or role.profile_id != profile.id:
                        raise PlanValidationError("Target role is not in the canonical Profile")
                    intent["display"] = {"before": {"目标岗位": role.role_name, "级别": role.role_level, "定位": role.fit},
                                         "after": "删除这一目标岗位", "rationale": str(intent.get("summary") or "")}
                    specific_targets.append({"kind": "target_role", "id": str(role.id), "title": role.role_name})
            if intent.get("operation") == "review_memory_proposal":
                identities.pop("proposal", None)
                memory = await db.get(MemoryProposal, args.get("proposal_id"))
                profile = (await db.execute(select(Profile).where(Profile.is_default.is_(True)))).scalar_one_or_none()
                if memory is None or profile is None:
                    raise PlanValidationError("Memory proposal or canonical Profile is missing")
                identities.update(memory_proposal=str(memory.id), profile=str(profile.id))
                intent["display"] = {"before": memory.before_json, "after": memory.after_json,
                                     "rationale": memory.reason, "action": args.get("action"), "impact": memory.impact_json}
            if intent.get("operation") in {"review_resume_proposal_item", "review_resume_proposal_items"}:
                proposal = await db.get(ResumeOptimizationProposal, args.get("proposal_id"))
                if proposal is None or proposal.workspace_resume_id != args.get("resume_id"):
                    raise PlanValidationError("Resume proposal is not bound to this workspace")
                identities.update(job=str(proposal.job_id), profile=str(proposal.profile_id))
                diffs = {str(item.get("change_id")): item for item in proposal.diff_json or [] if isinstance(item, dict)}
                change_ids = args.get("change_ids") or [args.get("change_id")]
                if not change_ids or any(str(change_id) not in diffs for change_id in change_ids):
                    raise PlanValidationError("Reviewed change set is missing")
                reviewed = []
                for change_id in change_ids:
                    change = copy.deepcopy(diffs[str(change_id)])
                    source_ids = change.get("source_section_ids") or (change.get("after") or {}).get("source_section_ids") or []
                    evidence = []
                    for source_id in source_ids:
                        section = await db.get(ProfileSection, source_id)
                        if section is not None and section.profile_id == proposal.profile_id:
                            evidence.append({"profile_section_id": section.id, "title": section.title, "content": section.content_json})
                    rationale = [item for item in (proposal.strategy_json or {}).get("rationale") or []
                                 if isinstance(item, dict) and set(item.get("source_section_ids") or []).intersection(source_ids)]
                    change["evidence"] = change.get("evidence") or evidence
                    change["rationale"] = change.get("rationale") or rationale
                    reviewed.append(change)
                intent["display"] = {"changes": reviewed, "action": args.get("action"), "rationale": proposal.strategy_json or {}}
            elif intent.get("operation") == "update_resume_section":
                section = await db.get(ResumeSection, args.get("section_id"))
                if section is None or section.resume_id != args.get("resume_id"):
                    raise PlanValidationError("Resume section is not in this workspace")
                before = _row(section)
                specific_targets.append({"kind": "resume_section", "id": str(section.id), "title": section.title})
                changes = copy.deepcopy(args.get("update_data") or {})
                intent["display"] = {"before": {key: before.get(key) for key in changes}, "after": changes,
                                     "rationale": str((intent.get("display") or {}).get("rationale") or intent.get("summary") or "")}
            elif intent.get("operation") == "reorder_resume_sections":
                sections = (await db.execute(select(ResumeSection).where(ResumeSection.resume_id == args.get("resume_id")).order_by(ResumeSection.sort_order, ResumeSection.id))).scalars().all()
                by_id = {section.id: section for section in sections}
                if any(item.get("id") not in by_id for item in args.get("items") or []):
                    raise PlanValidationError("Reordered section is missing")
                order = {item["id"]: item["sort_order"] for item in args["items"]}
                after = sorted(sections, key=lambda section: (order.get(section.id, section.sort_order), section.id))
                intent["display"] = {"before": [section.title for section in sections], "after": [section.title for section in after],
                                     "rationale": str(intent.get("summary") or "")}
            elif intent.get("operation") == "create_resume_section":
                intent["display"] = {"before": None, "after": {"标题": args.get("title", ""), "内容": args.get("content_json", []),
                                     "显示": args.get("visible", True), "顺序": args.get("sort_order", 0)}, "rationale": str(intent.get("summary") or "")}
            elif intent.get("operation") == "create_resume_version_record":
                intent["display"] = {"before": "当前版本历史", "after": {"新版本说明": args.get("change_summary", ""), "简历": args.get("resume_id")},
                                     "rationale": str(intent.get("summary") or "")}
            elif intent.get("operation") == "update_resume_record":
                resume = await db.get(Resume, args.get("resume_id"))
                if resume is None:
                    raise PlanValidationError("Resume is missing")
                changes = args.get("update_data") or {}
                current = _row(resume)
                intent["display"] = {"before": {key: current.get(key) for key in changes}, "after": copy.deepcopy(changes), "rationale": str(intent.get("summary") or "")}
            elif intent.get("operation") == "triage_job":
                job = await db.get(Job, args.get("job_id"))
                if job is None:
                    raise PlanValidationError("Job is missing")
                intent["display"] = {"before": {"岗位": job.title, "公司": job.company, "状态": job.triage_status},
                                     "after": {"岗位": job.title, "公司": job.company, "状态": args.get("status")}, "rationale": str(intent.get("summary") or "")}
                intent["display"]["before"]["岗位池"] = job.pool_id
                intent["display"]["after"]["岗位池"] = args.get("pool_id") or (job.pool_id if args.get("status") in {"picked", "screened"} else None)
            elif intent.get("operation") == "reset_local_business_data":
                intent["display"] = {
                    "before": "当前 OfferU 的档案、岗位、简历、投递、面试、职业记忆与 Agent 会话",
                    "after": "先保存可恢复备份，再清空职业工作区、旧会话和索引，建立空白档案",
                    "rationale": "这是独立的全清决定，不采用任何模型推断的职业事实",
                    "preserved": "Provider 凭据、配置、备份、审计、外部原简历与外部 Agent Memory",
                }
            elif not intent.get("display") or not any(key in intent["display"] for key in ("before", "after", "changes")):
                from app.ops import OPERATIONS
                operation = OPERATIONS.get(str(intent.get("operation") or ""))
                visible_inputs = copy.deepcopy(args)
                for key, value in list(visible_inputs.items()):
                    if isinstance(value, str) and (key.endswith("_b64") or value.startswith("data:")):
                        visible_inputs[key] = {"内容长度": len(value), "内容摘要": canonical_digest(value)}
                intent["display"] = {"before": "本计划尚未执行这项请求", "after": {
                    "请求": operation.description if operation is not None else str(intent.get("summary") or ""),
                    "具体内容与目标": visible_inputs}, "rationale": str(intent.get("summary") or "")}
            versions = {}
            targets = []
            for kind, identity in identities.items():
                material = await _source(db, kind, identity)
                versions[f"{kind}:{identity}"] = canonical_digest(material)
                if args.get(f"{kind}_id") is not None or kind in {"profile", "memory_proposal"} and intent["operation"] in {"update_profile", "create_target_role", "delete_target_role", "review_memory_proposal"}:
                    targets.append({"kind": "resume_proposal" if kind == "proposal" else kind,
                                    "id": identity, "title": material.get("title") or material.get("name") or ""})
            for reference, material in workspace_references.items():
                versions[reference] = canonical_digest(material)
            if intent.get("operation") in {"batch_triage", "batch_update_jobs"}:
                for identity in args.get("job_ids") or []:
                    material = await _source(db, "job", str(identity))
                    versions[f"job:{identity}"] = canonical_digest(material)
                    targets.append({"kind": "job", "id": identity, "title": material["title"]})
            # Names supplied by the model cannot disguise the actual mutation
            # target. Canonical IDs remain visible in review alongside titles.
            intent["affected_entities"] = [*targets, *specific_targets] or [{"kind": key.removesuffix("_id"), "id": value}
                                                       for key, value in args.items() if key.endswith("_id")]
            # Do not trust invented caller version hashes. Canonical local reads
            # bind the source actually displayed and used by these operations.
            intent["source_versions"] = versions
    return prepared


async def validate_source_versions(versions: dict[str, str]) -> None:
    async with async_session() as db:
        for reference, expected in versions.items():
            kind, _, identity = reference.partition(":")
            if canonical_digest(await _source(db, kind, identity)) != expected:
                raise PlanValidationError(f"Source {reference} changed; display and review a new plan")
