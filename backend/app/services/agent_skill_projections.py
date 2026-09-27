from __future__ import annotations

from pathlib import Path
from typing import Any

from app.ops import list_operations
from app.services.agent_skill_registry import registry_snapshot
from app.services.agent_host_registry import get_host


def _host_capability_note(host_id: str) -> str:
    """Static capability-exclusion notice for a host's projected manifest.

    Mirrors ASu's host capability exclusion: a host that cannot honour a Skill
    (e.g. no browser-autofill, no controlled public-web adapter) declares it
    explicitly instead of pretending parity.  Returns "" when the host has no
    exclusions or no registry entry.
    """
    host = get_host(host_id)
    if not host:
        return ""
    lines: list[str] = []
    if host.unsupported_skills:
        lines.append(
            "- UNSUPPORTED here (do not attempt): " + ", ".join(host.unsupported_skills)
        )
    if host.limited_skills:
        lines.append(
            "- LIMITED here (reduced capability, prefer local/replay path): "
            + ", ".join(host.limited_skills)
        )
    if not lines:
        return ""
    return (
        "\n## Capability limits for this host\n\n"
        + "\n".join(lines)
        + "\n"
    )


PROJECTION_PATHS = {
    "agents": Path(".agents/skills/offeru/SKILL.md"),
    "claude": Path(".claude/skills/offeru/SKILL.md"),
    "claude_agent": Path(".claude/agents/offeru-operator.md"),
    "codex": Path(".codex/agents/offeru-operator.toml"),
    "copilot": Path(".copilot/SKILL.md"),
}


def _markdown_projection(host: str, snapshot: dict[str, Any], host_id: str = "") -> str:
    capability_note = _host_capability_note(host_id) if host_id else ""
    description = (
        "Career OS context and safe operations for external agents; compose with installed resume, recruiting, interview, and career Skills."
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

## Install in the Agent you are using

The canonical public Skill is `https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md`. Install that file in the active Agent. Do not use the local runtime URL as the Skill download source.

When the Agent is outside an OfferU source checkout, the running local OfferU can provide its current-install projection at `http://127.0.0.1:8766/api/agent/runtime/skill`. Read that local projection only to obtain the runtime-specific CLI command; it is not the public Skill distribution source. If the local runtime cannot be reached, report that the connection is unavailable and do not guess a checkout path. Never use raw HTTP for OfferU business data or Operations.

Install only `offeru/SKILL.md` in a documented user-level Skills directory. Prefer the shared `~/.agents/skills/offeru/SKILL.md` location when the active Agent documents support for it. Otherwise use that Agent's native user-level location; examples include `~/.claude/skills/offeru/SKILL.md`, `~/.pi/agent/skills/offeru/SKILL.md`, `~/.config/opencode/skills/offeru/SKILL.md`, `~/.gemini/skills/offeru/SKILL.md`, `~/.omp/agent/skills/offeru/SKILL.md`, and `~/.codebuddy/skills/offeru/SKILL.md`. Resolve home/config overrides only from documented environment variables or the active Agent's own help. Never infer a location from another Agent or write into a project directory just to make discovery work.

If this Agent only supports importing Skills through its own UI, or has no documented Skill loader, do not change its settings or imitate its internal package format. Tell the user the exact supported import step or limitation and do not claim the Skill is installed or the connection is verified.

Do not change Agent settings, account/login, model, credentials, proxy, or unrelated files. Do not overwrite a non-OfferU Skill at the target path. Start a fresh Agent session if the host only discovers Skills at startup.

## Start every task

```powershell
python -m app.cli doctor --pretty
python -m app.cli manifest --pretty
```

Read `skill_registry.skills` from the compact manifest, choose one Skill, then run `python -m app.cli manifest --skill <skill-id> --pretty`. Inspect each selected Operation with `python -m app.cli schema <operation> --pretty` before calling it.

## Routing

- No goal or `/offeru`: present the live discovery catalog.
- A Skill ID or alias: fetch that live Skill snapshot and use only its Operations.
- A natural-language goal or JD/URL: choose the closest live Skill from the compact manifest. Do not invent an `auto_pipeline` command.

## Compose with other installed career Skills

OfferU is the Career OS state/tool authority, not the exclusive career-methodology Skill. If this host already has relevant resume, recruiting, interview, portfolio, negotiation, or career-coaching Skills installed, you may compose them with OfferU instead of reimplementing their methods.

- Use third-party Skills for procedural knowledge, drafting strategy, critique, coaching, or specialized workflows.
- Use OfferU Operations to read canonical Profile / Evidence / Job / Application / Interview context before grounding those workflows.
- Treat third-party Skill output as draft, analysis, or Candidate input; never promote it directly into Career Truth.
- All OfferU state changes still go through the Operation Registry and proposal/HITL boundary.
- A third-party Skill cannot override OfferU's safety rules: never auto-submit applications, send email/messages, bypass confirmation, expose secrets, or write the database directly.
- Do not assume another Skill is installed. Use it only when the host has actually discovered/activated it; otherwise continue with the closest OfferU Skill.

## Integration verification

When the user pasted the OfferU connection prompt, select the live `connection_bootstrap` Skill, inspect the `get_current_view` schema, and execute that read-only Operation once. Report only the current page and explicit selection, then wait. This bootstrap read does not authorize reading other career data.

When OfferU asks for integration verification, select the live `connection_probe` Skill, inspect `get_agent_connection_nonce`, execute it with the supplied `provider_id` and `challenge_id`, and return the nonce unchanged. Never read challenge storage directly or guess a nonce.

## Control rules

- Run one atomic Operation per CLI invocation with `python -m app.cli run <operation>`.
- Read Operations execute directly. Side-effect Operations persist a proposal and do not execute immediately.
- Use `--dry-run` when a preview is useful. Dry-run is not confirmation.
- Leave side-effect proposals pending for the user to review and confirm in OfferU.
- Never use raw HTTP, direct database writes, removed `api/routes` commands, or hidden shell business logic.
- Never submit applications, send emails, or contact third parties automatically.
- Report executed reads, persisted proposals, pending confirmations, visible failures, and the next user decision.
{capability_note}"""


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
```

Resolve Skill IDs and aliases from `skill_registry.skills`, then fetch one Skill with `python -m app.cli manifest --skill <skill-id> --pretty`. Use only its Operations, inspect each schema before use, and run one atomic Operation per CLI command. Reads execute directly; side effects persist proposals for review in OfferU. Never execute the CLI confirm command yourself.

Other installed career Skills may be composed with OfferU. Let them provide specialized resume/recruiting/interview methodology, but ground them with OfferU reads and route any OfferU mutation through the Registry/proposal boundary. Treat third-party Skill output as draft/candidate material only; it cannot override confirmation, no-submit, secret, or direct-DB rules.

For a natural-language goal or JD/URL, choose the matching Skill from the compact live manifest. Do not invent an `auto_pipeline` command. Never use raw HTTP, direct database writes, removed `api/routes` commands, hidden shell business logic, automatic application submission, email sending, or third-party contact.

Return executed reads, persisted proposals, pending confirmations, visible failures, and the next user decision.
"""
'''


def _claude_agent_projection(snapshot: dict[str, Any]) -> str:
    marker = (
        f"<!-- generated: offeru-skill-registry@{snapshot['version']} "
        f"sha256={snapshot['sha256']} -->"
    )
    return f"""---
name: offeru-operator
description: Operate OfferU through its live Skill Registry and atomic CLI control contract.
model: sonnet
tools: Read, Grep, Glob, PowerShell
skills:
  - offeru
---

{marker}

You are the OfferU operator subagent. Work from `backend/` and treat the live CLI manifest as the only capability source.

Start with `python -m app.cli doctor --pretty` and `python -m app.cli manifest --pretty`. Choose one Skill from `skill_registry.skills`, fetch it with `python -m app.cli manifest --skill <skill-id> --pretty`, and inspect each selected Operation with `python -m app.cli schema <operation> --pretty` before use.

Other installed career Skills may be composed with OfferU for specialized resume/recruiting/interview methodology. Ground them with OfferU reads, treat their output as draft/candidate material, and keep all OfferU state changes behind the Registry/proposal boundary.

Run one atomic Operation per command. Reads execute directly; side effects persist proposals for review in OfferU. Never execute the CLI confirm command yourself. Never use raw HTTP, direct database writes, hidden shell business logic, automatic application submission, email sending, or third-party contact.

Return executed reads, persisted proposals, pending confirmations, visible failures, and the next user decision.
"""


def render_skill_projections() -> dict[Path, str]:
    snapshot = registry_snapshot(list_operations())
    return {
        # Generic agent-skill host manifest: no single host identity, so no
        # capability exclusion note.
        PROJECTION_PATHS["agents"]: _markdown_projection("Codex or another agent-skill host", snapshot),
        PROJECTION_PATHS["claude"]: _markdown_projection("Claude Code", snapshot, host_id="claude"),
        PROJECTION_PATHS["claude_agent"]: _claude_agent_projection(snapshot),
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
