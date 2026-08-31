from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

from app.services.agent_skill_registry import AgentSkill
from app.services.security_redaction import safe_error_message

logger = logging.getLogger(__name__)

# 用户自定义技能根目录：backend/skills/<skill-name>/SKILL.md
# （omp 模式：非递归扫描一层，frontmatter 声明 name/description/tools 等）
SKILLS_ROOT = Path(__file__).resolve().parents[2] / "skills"

# 未声明 tools 时的默认只读工具白名单（自定义技能默认不能触碰写操作）
DEFAULT_READONLY_TOOLS = (
    "get_profile",
    "list_profile_evidence",
    "list_jobs",
    "get_job",
    "job_stats",
    "list_resumes",
    "get_resume",
    "list_applications",
    "get_application_workspace",
    "list_application_events",
    "list_career_artifacts",
    "get_career_artifact",
    "list_learning_observations",
    "list_memory_inbox",
    "list_calendar_events",
    "list_interview_questions",
)

_CACHE: list[AgentSkill] | None = None


def reload_directory_skills() -> None:
    """清空扫描缓存，下次 catalog/resolve 时重新扫描磁盘。"""
    global _CACHE
    _CACHE = None


def scan_directory_skills() -> list[AgentSkill]:
    """非递归扫描 SKILLS_ROOT/<name>/SKILL.md，解析 frontmatter 注册为技能。

    - description 必填（缺失跳过并记录警告）
    - tools 声明允许的 Operation 白名单；未声明用默认只读集
    - 内置技能（代码注册表）优先级更高：同名目录技能被忽略
    """
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    found: list[AgentSkill] = []
    if not SKILLS_ROOT.is_dir():
        _CACHE = found
        return found
    for skill_dir in sorted(SKILLS_ROOT.iterdir()):
        if not skill_dir.is_dir():
            continue
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.is_file():
            continue
        skill = _parse_skill_file(skill_dir, skill_file)
        if skill is not None:
            found.append(skill)
    _CACHE = found
    return found


def _parse_skill_file(skill_dir: Path, skill_file: Path) -> AgentSkill | None:
    try:
        text = skill_file.read_text(encoding="utf-8")
    except OSError:
        return None
    if not text.startswith("---"):
        logger.warning("[directory-skill] %s 缺少 frontmatter，跳过", skill_dir.name)
        return None
    end = text.find("\n---", 3)
    if end < 0:
        logger.warning("[directory-skill] %s frontmatter 未闭合，跳过", skill_dir.name)
        return None
    try:
        meta = yaml.safe_load(text[3:end]) or {}
    except yaml.YAMLError as exc:
        logger.warning(
            "[directory-skill] %s frontmatter 解析失败: %s",
            skill_dir.name,
            safe_error_message(exc),
        )
        return None
    if not isinstance(meta, dict):
        return None
    description = str(meta.get("description") or "").strip()
    if not description:
        logger.warning("[directory-skill] %s 缺少 description，跳过", skill_dir.name)
        return None

    skill_id = str(meta.get("name") or skill_dir.name).strip().lower().replace("-", "_")
    if not skill_id or not all(part.isalnum() or part == "_" for part in skill_id.split("_")):
        skill_id = skill_dir.name.lower().replace("-", "_")
    raw_tools = meta.get("tools")
    if isinstance(raw_tools, list):
        tools = tuple(
            str(item).strip()
            for item in raw_tools
            if isinstance(item, str) and str(item).strip()
        )
    elif isinstance(raw_tools, str):
        tools = tuple(part.strip() for part in raw_tools.split(",") if part.strip())
    else:
        tools = DEFAULT_READONLY_TOOLS
    raw_aliases = meta.get("aliases")
    if isinstance(raw_aliases, list):
        aliases = tuple(
            str(item).strip().lstrip("/")
            for item in raw_aliases
            if isinstance(item, str) and str(item).strip()
        )
    else:
        aliases = ()
    return AgentSkill(
        id=skill_id,
        name=str(meta.get("display_name") or meta.get("name") or skill_dir.name).strip(),
        group=str(meta.get("group") or "custom").strip() or "custom",
        status="native",
        description=description,
        mode="skill_assistant",
        allowed_tools=frozenset(tools),
        featured=bool(meta.get("featured", False)),
        order=int(meta.get("order") or 900),
        version=str(meta.get("version") or "directory"),
        missing_capabilities=(),
        aliases=aliases,
    )
