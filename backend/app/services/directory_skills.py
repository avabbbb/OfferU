from __future__ import annotations

import logging
import os
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
_LOCAL_CACHE: list[AgentSkill] | None = None

# 本机共享技能目录（只读导入；OfferU 永不写入这些目录）。测试可用该环境变量覆盖。
LOCAL_SKILL_DIRS_ENV = "OFFERU_LOCAL_SKILL_DIRS"
# OfferU 投影给外部 Agent 的自身技能目录名：导入时跳过，避免自我回环。
_OWN_PROJECTION_DIR = "offeru"
# 本机技能正文进入 prompt 的字符上限
LOCAL_SKILL_INSTRUCTIONS_MAX_CHARS = 12_000


def reload_directory_skills() -> None:
    """清空扫描缓存（目录技能与本机技能），下次 catalog/resolve 时重新扫描磁盘。"""
    global _CACHE, _LOCAL_CACHE
    _CACHE = None
    _LOCAL_CACHE = None


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


def local_skill_roots() -> list[tuple[str, Path]]:
    """本机共享技能根目录 (source, path)。

    设置 OFFERU_LOCAL_SKILL_DIRS（os.pathsep 分隔）时改用这些路径，source 为 local；空串 = 无根目录。
    """
    override = os.environ.get(LOCAL_SKILL_DIRS_ENV)
    if override is not None:
        return [
            ("local", Path(part.strip()).expanduser())
            for part in override.split(os.pathsep)
            if part.strip()
        ]
    try:
        home = Path.home()
    except RuntimeError:
        return []
    return [
        ("local:agents", home / ".agents" / "skills"),
        ("local:claude", home / ".claude" / "skills"),
    ]


def scan_local_skills() -> list[AgentSkill]:
    """只读导入本机共享技能：非递归扫描 <root>/<name>/SKILL.md，绝不写盘。

    - 跳过 offeru 目录（OfferU 自身投影）
    - id 已被内置技能、目录技能或更早的本机根目录占用则跳过
    - 工具只保留只读白名单交集，永不授予写操作
    - 不可读目录静默容忍
    """
    global _LOCAL_CACHE
    if _LOCAL_CACHE is not None:
        return _LOCAL_CACHE
    from app.services.agent_skill_registry import AUTO_SKILL_ID, _SKILLS

    taken = {_OWN_PROJECTION_DIR, AUTO_SKILL_ID}
    taken.update(skill.id for skill in _SKILLS)
    taken.update(skill.id for skill in scan_directory_skills())
    found: list[AgentSkill] = []
    for source, root in local_skill_roots():
        try:
            entries = sorted(root.iterdir()) if root.is_dir() else []
        except OSError as exc:
            logger.warning("[local-skill] 无法读取 %s 技能目录: %s", source, safe_error_message(exc))
            continue
        for skill_dir in entries:
            try:
                if skill_dir.name.lower() == _OWN_PROJECTION_DIR or not skill_dir.is_dir():
                    continue
                skill_file = skill_dir / "SKILL.md"
                if not skill_file.is_file():
                    continue
            except OSError:
                continue
            skill = _parse_skill_file(skill_dir, skill_file, source=source)
            if skill is None or skill.id in taken:
                continue
            taken.add(skill.id)
            found.append(skill)
    _LOCAL_CACHE = found
    return found


def _parse_skill_file(skill_dir: Path, skill_file: Path, source: str = "") -> AgentSkill | None:
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
    name = str(meta.get("display_name") or meta.get("name") or skill_dir.name).strip()
    if source:
        # 本机技能：只读白名单交集，声明的写工具一律丢弃；交集为空回落到默认只读集。
        readonly = frozenset(DEFAULT_READONLY_TOOLS)
        body_start = text.find("\n", end + 4)
        body = "" if body_start < 0 else text[body_start + 1:].strip()
        return AgentSkill(
            id=skill_id,
            name=name,
            group="local",
            status="native",
            description=description,
            mode="skill_assistant",
            allowed_tools=(frozenset(tools) & readonly) or readonly,
            featured=False,
            order=950,
            version="local",
            missing_capabilities=(),
            aliases=aliases,
            source=source,
            instructions=body[:LOCAL_SKILL_INSTRUCTIONS_MAX_CHARS],
        )
    return AgentSkill(
        id=skill_id,
        name=name,
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
