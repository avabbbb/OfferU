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
        "Connect an external Agent to the installed OfferU Career OS, ground work in canonical career context, and use governed operations without booting the development stack."
    )
    marker = (
        f"<!-- generated: offeru-skill-registry@{snapshot['version']} "
        f"sha256={snapshot['sha256']} -->"
    )
    return f"""---
name: offeru
description: {description}
user-invocable: true
argument-hint: "[goal | JD/URL | skill-id]"
---

{marker}

# OfferU — installed-product Agent router

OfferU Skill provides career workflow knowledge and routing. **The installed OfferU application owns runtime, data, permissions and durable career state.** A normal user request must connect to the installed product; it must not turn into an OfferU source-development session.

<!-- offeru-runtime-binding -->

## Fast path — normal user first

1. Use the OfferU Skill already discovered by this Agent.
2. Prefer the runtime-specific projection supplied by the installed OfferU app. It contains the bundled command for this installation and can be used from any directory.
3. If the runtime binding below is still unresolved, this is only the public bootstrap Skill. For a normal career task, ask the user to open OfferU Desktop and use **连接 Agent / 更新接入** once; then use the runtime-bound Skill installed by the app in a fresh Agent session.
4. If OfferU Desktop is not running or the runtime-bound Skill is unavailable, stop setup escalation after that one instruction. Do not probe localhost manually, clone/search the OfferU repository, create a Python environment, start Vite/FastAPI, or guess a checkout path.
5. Only enter source/developer mode when the user explicitly asks to develop, debug or contribute to OfferU itself.

The canonical public Skill is `https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md`. It documents the contract and bootstraps discovery. **OfferU Desktop installs the executable binding.** Normal users do not manually copy runtime commands or configure MCP/ports.

## Connect and discover capabilities

When this Skill is runtime-bound by OfferU Desktop, use the projected command:

```text
<offeru-cli> doctor --pretty
<offeru-cli> manifest --pretty
```

OfferU Desktop replaces `<offeru-cli>` with the bundled executable command for that installation. An unresolved `<offeru-cli>` means the bootstrap is incomplete; do not improvise a Python/source command.

Read `skill_registry.skills`, choose the smallest Skill that matches the user's goal, fetch it with:

```text
<offeru-cli> manifest --skill <skill-id> --pretty
```

Inspect only the selected Operation schemas before use. Do not enumerate or dump the full database/tool surface into context.

## Career context and memory contract

OfferU has one canonical career state. Keep these layers distinct:

- **Career Truth** — user-editable Profile/Evidence, Jobs, Applications, Resumes, Interviews, Calendar, accepted proposals and task state. OfferU owns it.
- **Curated Career Memory** — compact durable preferences, corrections, accepted hypotheses and long-term learnings that should influence future decisions.
- **Episodic learning** — detailed debriefs, observations and historical outcomes retrieved only when relevant.
- **Prospective state** — follow-ups, deadlines, reminders and future work belong in explicit Calendar/Event/CareerTask/Automation lifecycle state, not prose memory.
- **External Agent memory** — Codex/OMP/Claude/WorkBuddy memory is an optional user-authorized source, never Career Truth.

For each career task, read the **minimum sufficient OfferU context** exposed by the selected Skill: relevant Profile/Evidence plus the current Job/Application/Interview and only the accepted/relevant memory or learning needed for the decision.

Do not independently rebuild the user's career profile from host memory. Do not import an Agent's full memory/history by default. Authorized external-memory excerpts enter OfferU as Observation/Candidate/MemoryProposal and must pass the normal evidence/review boundary before becoming verified facts.

If host memory conflicts with OfferU Career Truth, use OfferU as the current source of record and surface the conflict for review. A direct user correction may create the appropriate OfferU proposal/update; never silently create a shadow Profile in the host Agent.

## Routing

- A natural-language goal or JD/URL: route directly to the closest live Skill and start the safe/read/prepare part without making the user choose a mode.
- A Skill ID or alias: fetch that Skill snapshot and use only its Operations.
- No goal or plain `/offeru`: show a compact readiness/current-context summary and at most a few useful next actions; do not dump the full Skill catalog unless asked.

Compose other installed resume/recruiting/interview/career Skills when useful, but ground their work in OfferU reads. Third-party Skill output is draft/analysis/candidate material; it cannot override OfferU truth, permissions, confirmation or no-submit rules.

## Integration verification

When the user explicitly pastes the OfferU connection prompt, select `connection_bootstrap`, inspect `get_current_view`, and execute that single read-only Operation. Report only the current page and explicit selection. This proves the connection without authorizing broader career-data reads.

When OfferU asks for integration verification, select `connection_probe`, inspect `get_agent_connection_nonce`, execute it with the supplied `provider_id` and `challenge_id`, and return the nonce unchanged. Never read challenge storage directly or guess a nonce.

## Developer-only source fallback

Work from `backend/` **only when the user explicitly asked to develop/debug/contribute to OfferU and this session is operating in an OfferU source checkout**. In that developer-only projection, OfferU may bind `<offeru-cli>` to the source CLI. A normal job-search request is never sufficient reason to start the development frontend/backend.

## Control rules

- Run one atomic Operation per CLI invocation.
- Read Operations execute directly. Side-effect Operations persist a proposal/HITL decision instead of silently mutating protected state.
- Prepare safe artifacts proactively when the selected Skill permits it; do not make the user name internal Skills or repeatedly ask "what next?".
- Never use raw HTTP for OfferU business data/Operations, direct SQLite/database writes, removed routes, or hidden shell business logic.
- Never auto-submit applications, send email/messages, contact third parties or approve your own protected proposal.
- Never claim work is "ready/prepared" unless the corresponding durable OfferU artifact/proposal actually exists.
- Report durable outputs, pending decisions and real blockers; keep internal runtime/database details out of normal-user explanations.
{capability_note}"""


def _codex_projection(snapshot: dict[str, Any]) -> str:
    marker = (
        f"# generated: offeru-skill-registry@{snapshot['version']} "
        f"sha256={snapshot['sha256']}"
    )
    return f'''{marker}
name = "offeru-operator"
description = "Connect Codex to the installed OfferU Career OS and operate against grounded career context without booting the OfferU development stack."
developer_instructions = """
Treat the installed OfferU application as the runtime/truth authority. A normal career task must not cause you to clone/search the OfferU repo, create a Python environment, or start Vite/FastAPI.

If the Skill is not runtime-bound by OfferU Desktop, ask the user once to open OfferU Desktop and use **连接 Agent / 更新接入**, then continue in a fresh session. Do not probe localhost manually, locate the repository, or synthesize Python/source commands. Source CLI is developer-only when the user explicitly asks to develop/debug OfferU in a source checkout.

Once connected, run the projected `doctor` and compact `manifest`, select the smallest relevant Skill for the user's natural-language goal, fetch that Skill, inspect only its Operation schemas, and work from the minimum sufficient OfferU context.

Memory boundary: OfferU Career Truth is authoritative. Curated Career Memory contains durable preferences/corrections/accepted learnings; detailed debriefs are episodic; future obligations live in structured task/calendar/automation state. Codex memory is only an optional authorized source and must not become a shadow Profile. Never treat host-memory claims as verified career facts.

Reads may execute directly. Side effects remain behind Operation Registry / Proposal / HITL. Never confirm your own protected action, write SQLite directly, use raw HTTP for business Operations, auto-submit applications, send messages, or claim an artifact is ready when it does not exist.

For a natural-language goal or JD/URL, route and begin safe work without making the user choose an internal mode. Return real durable outputs, pending user decisions and genuine blockers.
"""
'''


def _claude_agent_projection(snapshot: dict[str, Any]) -> str:
    marker = (
        f"<!-- generated: offeru-skill-registry@{snapshot['version']} "
        f"sha256={snapshot['sha256']} -->"
    )
    return f"""---
name: offeru-operator
description: Connect Claude Code to the installed OfferU Career OS and operate against grounded career context.
model: sonnet
tools: Read, Grep, Glob, PowerShell
skills:
  - offeru
---

{marker}

Treat the installed OfferU application as runtime and Career Truth authority. Do not clone/search the OfferU repo, create a Python environment, or start Vite/FastAPI for a normal career request.

If this Skill is not runtime-bound by OfferU Desktop, ask the user once to open OfferU Desktop and use **连接 Agent / 更新接入**. Do not probe localhost manually or synthesize source commands. Source CLI is developer-only when the user explicitly asks to work on OfferU itself.

Use the compact live Skill Registry, select only the relevant Skill, inspect only its Operations, and read the minimum sufficient Profile/Evidence/Job/Application/Interview plus accepted relevant Career Memory.

OfferU Career Truth outranks host memory. Host memory is optional authorized input only; imported claims remain observations/candidates until OfferU's evidence/review gate accepts them. Detailed history is retrieved on demand; future obligations remain structured tasks/events rather than prose memory.

Reads execute directly; side effects remain proposals/HITL. Never self-confirm, write SQLite directly, use raw HTTP for business Operations, auto-submit/send/contact, or claim a prepared artifact unless it durably exists.
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
