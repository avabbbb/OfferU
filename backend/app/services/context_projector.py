"""Context projector for Run artifact workspaces (Slice 4).

Projects exactly what one external-Harness Run may see: the bound Job's
public record and the candidate profile facts that already passed the
confirmation gates. Nothing else — no inbox, no email, no other Runs, no
research not yet accepted. This is the read-only context a deep executor
gets alongside its confined workspace.
"""

from __future__ import annotations

import json
from typing import Any

from app.services.artifact_workspace import ArtifactWorkspaceManager


class ContextProjector:
    """Build and persist the minimal, confirmed context for one Run."""

    def __init__(self, workspace: ArtifactWorkspaceManager):
        self.workspace = workspace

    async def project(self, *, job_id: int) -> dict[str, Any]:
        """Project the Run context: the Job + confirmed profile facts only."""
        job = await self._load_job(job_id)
        profile = await self._load_confirmed_profile()
        context = {
            "schema": "offeru.run_context.v1",
            "runId": self.workspace.run_id,
            "job": job,
            "candidate": profile,
            "confirmedAt": None,  # set by caller when facts are frozen
        }
        self.workspace.context_path.write_text(
            json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return context

    async def _load_job(self, job_id: int) -> dict[str, Any]:
        from sqlalchemy import select

        from app.database import async_session
        from app.models.models import Job

        async with async_session() as db:
            row = (
                await db.execute(select(Job).where(Job.id == int(job_id)))
            ).scalar_one_or_none()
        if row is None:
            raise ValueError(f"Job {job_id} does not exist")
        # Public job record only; no applicant-owned fields.
        return {
            "id": row.id,
            "title": row.title,
            "company": row.company,
            "location": row.location or "",
            "url": row.url or "",
            "raw_description": (row.raw_description or "")[:4000],
            "triage_status": row.triage_status,
            "source": row.source or "",
        }

    async def _load_confirmed_profile(self) -> dict[str, Any]:
        from sqlalchemy import select

        from app.database import async_session
        from app.models.models import ProfileSection

        async with async_session() as db:
            rows = (
                (
                    await db.execute(
                        select(ProfileSection)
                        .where(
                            ProfileSection.tier.in_(("verified_fact", "preference")),
                            ProfileSection.status == "active",
                        )
                        .order_by(ProfileSection.section_type, ProfileSection.sort_order)
                    )
                )
                .scalars()
                .all()
            )
        confirmed: dict[str, list[dict[str, Any]]] = {}
        for section in rows:
            confirmed.setdefault(section.section_type, []).append(
                {
                    "title": section.title,
                    "content": json.dumps(section.content_json, ensure_ascii=False)[:2000]
                    if isinstance(section.content_json, dict)
                    else str(section.content_json or "")[:2000],
                    "tier": section.tier,
                    "source": section.source,
                    "confidence": section.confidence,
                }
            )
        return confirmed


__all__ = ["ContextProjector"]
