from __future__ import annotations

from pathlib import Path
from typing import Any

from app.ops import list_operations
from app.services.agent_skill_registry import registry_snapshot


PROJECTION_PATHS = {
    "agents": Path(".agents/skills/offeru/SKILL.md"),
    "claude": Path(".claude/skills/offeru/SKILL.md"),
    "codex": Path(".codex/agents/offeru-operator.toml"),
    "copilot": Path(".copilot/SKILL.md"),
}


def _markdown_projection(host: str, snapshot: dict[str, Any]) -> str:
    description = (
        f"Use when operating OfferU through {host}. Provides live Skill discovery, "
        "atomic CLI operations, and human-confirmed side effects."
    )
    marker = (
        f"<!-- generated: offeru-skill-registry@{snapshot['version']} "
        f"sha256={snapshot['sha256']} -->"
    )
    return f"""---
name: offeru
description: {description}
user-invocable: true
argument-hint: "[skill-id | goal | JD/URL]"
---

{marker}

# OfferU External-Agent Router

Work from `backend/`. The live CLI manifest is the source of truth; this generated file contains no business workflow definitions.

## Start every task

```powershell
python -m app.cli doctor --pretty
python -m app.cli manifest --pretty
python -m app.cli run agent_playbook --arg detail=full --pretty
```

Read `skill_registry.skills` from the manifest to resolve Skill IDs, aliases, versions, allowed Operations, missing capabilities, and confirmation-required Operations. Inspect each Operation with `python -m app.cli schema <operation> --pretty` before calling it.

## Routing

- No goal or `/offeru`: present the live discovery catalog.
- A Skill ID or alias: use that live Skill snapshot and only its allowed Operations.
- A natural-language goal or JD/URL: discover a matching Skill or workflow from the live manifest/playbook. Do not invent an `auto_pipeline` command.

## Control rules

- Run one atomic Operation per CLI invocation with `python -m app.cli run <operation>`.
- Read Operations execute directly. Side-effect Operations persist a proposal and do not execute immediately.
- Use `--dry-run` when a preview is useful. Dry-run is not confirmation.
- Only after explicit user confirmation, execute the returned proposal once with `python -m app.cli confirm <run_id> --action <action_id> --pretty`.
- Never use raw HTTP, direct database writes, removed `api/routes` commands, or hidden shell business logic.
- Never submit applications, send emails, or contact third parties automatically.
- Report executed reads, persisted proposals, pending confirmations, visible failures, and the next user decision.
"""


def _codex_projection(snapshot: dict[str, Any]) -> str:
    marker = (
        f"# generated: offeru-skill-registry@{snapshot['version']} "
        f"sha256={snapshot['sha256']}"
    )
    return f'''{marker}
name = "offeru-operator"
description = "Operate OfferU through its live Skill Registry and atomic CLI control contract."
developer_instructions = """
You are the OfferU operator. Work from `backend/` and treat the live CLI manifest as the only capability source.

Start every task by running:

```powershell
python -m app.cli doctor --pretty
python -m app.cli manifest --pretty
python -m app.cli run agent_playbook --arg detail=full --pretty
```

Resolve Skill IDs and aliases from `skill_registry.skills`. Use only the selected Skill's allowed Operations, inspect each schema before use, and run one atomic Operation per CLI command. Reads execute directly; side effects persist proposals. Only after explicit user confirmation may you run `python -m app.cli confirm <run_id> --action <action_id> --pretty` once.

For a natural-language goal or JD/URL, discover the matching Skill or workflow from the live manifest/playbook. Do not invent an `auto_pipeline` command. Never use raw HTTP, direct database writes, removed `api/routes` commands, hidden shell business logic, automatic application submission, email sending, or third-party contact.

Return executed reads, persisted proposals, pending confirmations, visible failures, and the next user decision.
"""
'''


def render_skill_projections() -> dict[Path, str]:
    snapshot = registry_snapshot(list_operations())
    return {
        PROJECTION_PATHS["agents"]: _markdown_projection("Codex or another agent-skill host", snapshot),
        PROJECTION_PATHS["claude"]: _markdown_projection("Claude Code", snapshot),
        PROJECTION_PATHS["codex"]: _codex_projection(snapshot),
        PROJECTION_PATHS["copilot"]: _markdown_projection("GitHub Copilot", snapshot),
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
