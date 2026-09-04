from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.services.agent_files import atomic_write_json
from app.runtime_paths import runtime_data_path

MEMORY_SCHEMA_VERSION = "offeru.agent_memory.v1"
MEMORY_DIR = runtime_data_path()
MEMORY_PATH = MEMORY_DIR / "harness_agent_memory.json"
LIST_FIELDS = ("facts", "preferences", "goals", "risks", "events")
VALID_STAGES = {"unknown", "campus", "experienced"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def empty_agent_memory() -> dict[str, Any]:
    return {
        "schema_version": MEMORY_SCHEMA_VERSION,
        "user_stage": "unknown",
        "confidence": 0.0,
        "facts": [],
        "preferences": [],
        "goals": [],
        "risks": [],
        "events": [],
        "updated_at": _now_iso(),
    }


def _dedupe(items: Any, *, limit: int = 80) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    if not isinstance(items, list):
        return result
    for item in items:
        text = str(item or "").strip()
        if not text:
            continue
        key = re.sub(r"\s+", " ", text).lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(text[:500])
        if len(result) >= limit:
            break
    return result


def normalize_agent_memory(payload: Any) -> dict[str, Any]:
    memory = empty_agent_memory()
    if not isinstance(payload, dict):
        return memory

    stage = str(payload.get("user_stage") or payload.get("stage") or "unknown").strip().lower()
    memory["user_stage"] = stage if stage in VALID_STAGES else "unknown"
    try:
        memory["confidence"] = min(max(float(payload.get("confidence", 0.0)), 0.0), 1.0)
    except Exception:
        memory["confidence"] = 0.0

    for field in LIST_FIELDS:
        memory[field] = _dedupe(payload.get(field), limit=120 if field == "events" else 80)

    memory["schema_version"] = MEMORY_SCHEMA_VERSION
    memory["updated_at"] = str(payload.get("updated_at") or _now_iso())
    return memory


def load_agent_memory(path: Path | None = None) -> dict[str, Any]:
    target = path or MEMORY_PATH
    if not target.exists():
        return empty_agent_memory()
    try:
        return normalize_agent_memory(json.loads(target.read_text(encoding="utf-8")))
    except Exception:
        return empty_agent_memory()


def save_agent_memory(memory: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    normalized = normalize_agent_memory({**memory, "updated_at": _now_iso()})
    target = path or MEMORY_PATH
    atomic_write_json(target, normalized)
    return normalized


def _parse_markdown_memory(text: str) -> dict[str, Any]:
    memory = empty_agent_memory()
    current_field = ""
    heading_map = {
        "facts": "facts",
        "fact": "facts",
        "事实": "facts",
        "preferences": "preferences",
        "preference": "preferences",
        "偏好": "preferences",
        "goals": "goals",
        "goal": "goals",
        "目标": "goals",
        "risks": "risks",
        "risk": "risks",
        "风险": "risks",
        "events": "events",
        "event": "events",
        "事件": "events",
    }
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        stage_match = re.search(r"(user_stage|stage|用户类型|求职类型)\s*[:：]\s*(campus|experienced|unknown|校招|社招)", line, re.I)
        if stage_match:
            stage = stage_match.group(2).lower()
            memory["user_stage"] = {"校招": "campus", "社招": "experienced"}.get(stage, stage)
            memory["confidence"] = max(float(memory["confidence"]), 0.8)
            continue
        if line.startswith("#"):
            heading = line.lstrip("#").strip().lower()
            current_field = heading_map.get(heading, "")
            continue
        if current_field in LIST_FIELDS:
            item = re.sub(r"^[-*+]\s*", "", line).strip()
            if item:
                memory[current_field].append(item)
    return normalize_agent_memory(memory)


def import_agent_memory_payload(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return normalize_agent_memory(payload)
    if isinstance(payload, str):
        text = payload.strip()
        if not text:
            return empty_agent_memory()
        try:
            return normalize_agent_memory(json.loads(text))
        except json.JSONDecodeError:
            return _parse_markdown_memory(text)
    return empty_agent_memory()


def export_agent_memory_markdown(memory: dict[str, Any]) -> str:
    normalized = normalize_agent_memory(memory)
    lines = [
        "# OfferU Agent Memory",
        "",
        f"user_stage: {normalized['user_stage']}",
        f"confidence: {normalized['confidence']:.2f}",
        f"updated_at: {normalized['updated_at']}",
        "",
    ]
    labels = {
        "facts": "Facts",
        "preferences": "Preferences",
        "goals": "Goals",
        "risks": "Risks",
        "events": "Events",
    }
    for field in LIST_FIELDS:
        lines.append(f"## {labels[field]}")
        values = normalized.get(field) or []
        if values:
            lines.extend(f"- {item}" for item in values)
        else:
            lines.append("- ")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def remember_turn(memory: dict[str, Any], user_message: str, *, stage: str | None = None) -> dict[str, Any]:
    next_memory = normalize_agent_memory(memory)
    if stage in VALID_STAGES and stage != "unknown":
        next_memory["user_stage"] = stage
        next_memory["confidence"] = max(float(next_memory.get("confidence") or 0), 0.75)

    text = str(user_message or "").strip()
    if not text:
        return next_memory

    event = f"{_now_iso()} 用户说：{text[:180]}"
    next_memory["events"] = _dedupe([event, *next_memory.get("events", [])], limit=120)

    if re.search(r"应届|校招|实习|毕业|大一|大二|大三|大四|研一|研二|研三|intern|campus", text, re.I):
        next_memory["facts"] = _dedupe([text[:180], *next_memory.get("facts", [])])
    if re.search(r"想找|目标|希望|优先|倾向|prefer|target|looking for", text, re.I):
        next_memory["goals"] = _dedupe([text[:180], *next_memory.get("goals", [])])
    if re.search(r"不要|不想|优先|远程|北京|上海|深圳|杭州|广州|prefer", text, re.I):
        next_memory["preferences"] = _dedupe([text[:180], *next_memory.get("preferences", [])])
    return next_memory
