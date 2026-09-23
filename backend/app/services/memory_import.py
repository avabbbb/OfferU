"""Import explicitly selected AI memory excerpts through the existing evidence gate."""

from hashlib import sha256
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.services.career_memory import create_memory_proposal, record_learning_observation


class MemoryImportInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_name: str = Field(min_length=1, max_length=200)
    excerpts: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(
        min_length=1, max_length=80,
    )
    consent: Literal[True]


async def import_memory_candidates(source_name: str, excerpts: list[str], consent: bool) -> dict:
    # Validate direct callers too; consent to read an export is not consent to
    # turn an AI's inference into a verified career fact.
    request = MemoryImportInput(source_name=source_name, excerpts=excerpts, consent=consent)
    selected = list(dict.fromkeys(text.strip() for text in request.excerpts if text.strip()))
    if not request.source_name.strip() or not selected:
        raise ValueError("请选择来源和至少一条职业线索")
    source_id = sha256(request.source_name.strip().encode("utf-8")).hexdigest()
    proposals = []
    duplicates = 0
    for excerpt in selected:
        digest = sha256(excerpt.encode("utf-8")).hexdigest()
        candidate = {
            "target_tier": "career_hypothesis",
            "section_type": "custom:c_agent_memory",
            "title": excerpt[:100],
            "after": {"statement": excerpt, "source_excerpt": excerpt},
            "reason": "来自使用者选择的 AI 记忆导出，仅作为待核实的职业线索；不作为已验证经历。",
            "impact": ["确认后保留为职业线索；正式经历仍需简历或使用者陈述作为证据"],
        }
        observation = await record_learning_observation(
            source_type="agent_session",
            source_external_id=f"memory-import:{source_id}",
            source_title=request.source_name.strip(),
            source_metadata={"storage": "selected_excerpts", "origin": "external_ai_memory"},
            observation_type="imported_memory_candidate",
            # The background distiller consumes prepared candidates directly.
            # It must not reinterpret imported AI claims as user-stated facts.
            content={"source_excerpt": excerpt, "memory_candidates": [candidate]},
            idempotency_key=f"memory-import:{source_id}:{digest}",
        )
        duplicates += int(bool(observation.get("duplicate")))
        proposals.append(await create_memory_proposal(
            observation_id=int(observation["id"]),
            **candidate,
        ))
    return {"items": proposals, "duplicates": duplicates, "imported": len(proposals)}
