from __future__ import annotations

from pathlib import Path

# The one hand-written Skill for external Agents (backend/skill/SKILL.md, under 4KB).
CORE_SKILL = Path(__file__).resolve().parents[2] / "skill" / "SKILL.md"

APP_VERSION = "0.2.0"

PROJECTION_PATHS = {
    "agents": Path(".agents/skills/offeru/SKILL.md"),
    "claude": Path(".claude/skills/offeru/SKILL.md"),
    "claude_agent": Path(".claude/agents/offeru-operator.md"),
    "codex": Path(".codex/agents/offeru-operator.toml"),
    "copilot": Path(".copilot/SKILL.md"),
}

_OPERATOR_DESCRIPTION = "用 OfferU 的工具处理求职任务：岗位、简历、档案、日程、网申和邮件草稿。"
_OPERATOR_BRIEF = """你是 OfferU 助手，按 offeru Skill 做事：
- 优先用 MCP 调 OfferU 的工具；没有 MCP 就用 Skill 里写的 offeru tool 命令。
- 开场先 overview。写入直接生效，用户能在「最近改动」撤销，所以不用先问。
- 不编造经历和数字；对外的事（网申、邮件、联系 HR）只写草稿，由用户自己发。
- 最后用一两句话说清改了什么、下一步是什么。
"""


def _claude_agent_projection() -> str:
    return f"""---
name: offeru-operator
description: {_OPERATOR_DESCRIPTION}
model: sonnet
tools: Read, Grep, Glob, PowerShell
skills:
  - offeru
---

{_OPERATOR_BRIEF}"""


def _codex_projection() -> str:
    return f'''name = "offeru-operator"
description = "{_OPERATOR_DESCRIPTION}"
developer_instructions = """
{_OPERATOR_BRIEF}"""
'''


def render_skill_projections() -> dict[Path, str]:
    core_skill = CORE_SKILL.read_text(encoding="utf-8")
    return {
        PROJECTION_PATHS["agents"]: core_skill,
        PROJECTION_PATHS["claude"]: core_skill,
        PROJECTION_PATHS["claude_agent"]: _claude_agent_projection(),
        PROJECTION_PATHS["codex"]: _codex_projection(),
        PROJECTION_PATHS["copilot"]: core_skill,
    }


def projection_drift(project_root: Path) -> list[str]:
    return [
        path.as_posix()
        for path, expected in render_skill_projections().items()
        if not (project_root / path).is_file()
        or (project_root / path).read_text(encoding="utf-8") != expected
    ]


def write_skill_projections(project_root: Path) -> list[str]:
    written: list[str] = []
    for path, content in render_skill_projections().items():
        target = project_root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
        written.append(path.as_posix())
    return written
