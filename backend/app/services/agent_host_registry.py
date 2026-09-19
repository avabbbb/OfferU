"""Agent Host Registry — single declaration of how OfferU meets external agents.

This separates two concepts that were previously conflated under the generic
name "provider"/"runtime":

* **Agent Host Integration** — a third-party agent the *user already owns*
  (Codex CLI, Claude Code, OpenCode, OMP, WorkBuddy).  OfferU only detects it,
  installs/updates the canonical OfferU Skill, and verifies the Bridge.  It does
  NOT own the agent's run lifecycle.

* **Hosted Agent Runtime** — an executor OfferU spawns and drives as a
  process/session (``RUNTIME_DEFINITIONS`` in ``coding_agent_runtime``):
  spawn / auth / thread / prompt / stream / cancel / resume / health.

A host may be ``skill_host`` (skill install only), ``hosted_runtime`` (OfferU
drives its lifecycle), or ``both`` (e.g. Codex can be installed as a skill *and*
spawned as an app-server runtime).

Downstream consumers — ``agent_connection`` (UI), ``agent_integration``
(install/detect), ``agent_skill_projections`` (manifest projection) — read this
single declaration instead of each keeping their own provider tables.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


HOST_KIND_SKILL_HOST = "skill_host"
HOST_KIND_HOSTED_RUNTIME = "hosted_runtime"
HOST_KIND_BOTH = "both"

# Skill support tiers for the Host × Skill matrix (Phase B6).
SUPPORT_FULL = "full"
SUPPORT_LIMITED = "limited"
SUPPORT_UNSUPPORTED = "unsupported"


@dataclass(frozen=True)
class AgentHost:
    """Declarative metadata for one external agent host."""

    id: str
    display_name: str
    # skill_host | hosted_runtime | both — see module docstring.
    kind: str
    # Surface the host to the beginner "Connect an Agent" flow.
    beginner: bool = False
    # Single recommended host for zero-friction setup.
    recommended: bool = False
    # Whether OfferU can install/update the canonical Skill into this host.
    can_install_skill: bool = False
    # Whether OfferU can live-verify the installed skill (bridge nonce probe).
    can_live_verify: bool = False
    # Whether the user can verify login state through this host.
    can_verify_login: bool = False
    # Hosted-runtime id in RUNTIME_DEFINITIONS when kind includes hosted_runtime.
    runtime_id: str | None = None
    # Projection key in agent_skill_projections.PROJECTION_PATHS that renders
    # this host's installable manifest, if any.
    projection_key: str | None = None
    # Capabilities this host cannot honour (host capability exclusion).
    # Skill ids listed here are projected as LIMITED/UNSUPPORTED for the host.
    unsupported_skills: tuple[str, ...] = ()
    limited_skills: tuple[str, ...] = ()
    docs_url: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def skill_support(self, skill_id: str) -> str:
        """Return this host's support tier for a Skill."""
        if skill_id in self.unsupported_skills:
            return SUPPORT_UNSUPPORTED
        if skill_id in self.limited_skills:
            return SUPPORT_LIMITED
        return SUPPORT_FULL

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "kind": self.kind,
            "beginner": self.beginner,
            "recommended": self.recommended,
            "can_install_skill": self.can_install_skill,
            "can_live_verify": self.can_live_verify,
            "can_verify_login": self.can_verify_login,
            "runtime_id": self.runtime_id,
            "projection_key": self.projection_key,
            "unsupported_skills": list(self.unsupported_skills),
            "limited_skills": list(self.limited_skills),
            "docs_url": self.docs_url,
        }


# ---------------------------------------------------------------------------
# Canonical host declarations.
#
# Ordering note: the *hosted-runtime* counterpart of a ``both`` host is owned by
# ``coding_agent_runtime.RUNTIME_DEFINITIONS`` (binary/protocol/lifecycle).  This
# registry only declares the *integration* face; it never duplicates the runtime
# spawn contract.
# ---------------------------------------------------------------------------

_HOSTS: tuple[AgentHost, ...] = (
    AgentHost(
        id="codex",
        display_name="Codex",
        kind=HOST_KIND_BOTH,
        beginner=True,
        recommended=True,
        can_install_skill=True,
        can_live_verify=True,
        can_verify_login=True,
        runtime_id="codex",
        projection_key="codex",
        docs_url="https://developers.openai.com/codex/quickstart/",
    ),
    AgentHost(
        id="claude",
        display_name="Claude Code",
        kind=HOST_KIND_BOTH,
        beginner=True,
        can_install_skill=True,
        runtime_id="claude",
        projection_key="claude",
        docs_url="https://code.claude.com/docs/en/setup",
    ),
    AgentHost(
        id="opencode",
        display_name="OpenCode",
        kind=HOST_KIND_BOTH,
        beginner=True,
        can_install_skill=True,
        runtime_id="opencode",
        # OpenCode runs ``run --pure``: no OfferU-controlled public-web adapter
        # is projected, so web-research skills degrade to limited.
        limited_skills=("company_research", "role_intelligence"),
        docs_url="https://opencode.ai/docs/",
    ),
    AgentHost(
        id="pi",
        display_name="Pi Coding Agent",
        kind=HOST_KIND_HOSTED_RUNTIME,
        runtime_id="pi",
        # Pi is a hosted executor only — no canonical skill install surface.
        unsupported_skills=("application_assistant",),
        docs_url="https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
    ),
    AgentHost(
        id="omp",
        display_name="Oh My Pi",
        kind=HOST_KIND_HOSTED_RUNTIME,
        runtime_id="omp",
        unsupported_skills=("application_assistant",),
        docs_url="https://github.com/can1357/oh-my-pi",
    ),
    AgentHost(
        id="gemini",
        display_name="Gemini CLI",
        kind=HOST_KIND_HOSTED_RUNTIME,
        runtime_id="gemini",
        docs_url="https://github.com/google-gemini/gemini-cli",
    ),
    AgentHost(
        id="codebuddy",
        display_name="WorkBuddy (CodeBuddy)",
        kind=HOST_KIND_HOSTED_RUNTIME,
        runtime_id="codebuddy",
        # WorkBuddy has no browser-autofill capability — mirror ASu's explicit
        # host exclusion instead of pretending feature parity.
        unsupported_skills=("application_assistant",),
        docs_url="https://www.workbuddy.cn/docs/workbuddy/Overview",
    ),
)

_BY_ID = {host.id: host for host in _HOSTS}


def list_hosts() -> list[AgentHost]:
    return list(_HOSTS)


def get_host(host_id: str) -> AgentHost | None:
    return _BY_ID.get(host_id)


def beginner_host_ids() -> list[str]:
    return [host.id for host in _HOSTS if host.beginner]


def recommended_host_id() -> str | None:
    for host in _HOSTS:
        if host.recommended:
            return host.id
    return None


def hosted_runtime_ids() -> list[str]:
    """Runtime ids this registry maps to RUNTIME_DEFINITIONS (kind hosted/both)."""
    return [host.runtime_id for host in _HOSTS if host.runtime_id]


def skill_host_ids() -> list[str]:
    """Hosts that accept a canonical skill install (kind skill_host/both)."""
    return [host.id for host in _HOSTS if host.kind in (HOST_KIND_SKILL_HOST, HOST_KIND_BOTH)]


def host_summaries() -> list[dict[str, Any]]:
    return [host.summary() for host in _HOSTS]


def host_capability_matrix(skill_ids: list[str]) -> dict[str, dict[str, str]]:
    """Host × Skill support matrix: {host_id: {skill_id: full|limited|unsupported}}."""
    return {
        host.id: {skill_id: host.skill_support(skill_id) for skill_id in skill_ids}
        for host in _HOSTS
    }


__all__ = [
    "AgentHost",
    "HOST_KIND_BOTH",
    "HOST_KIND_HOSTED_RUNTIME",
    "HOST_KIND_SKILL_HOST",
    "SUPPORT_FULL",
    "SUPPORT_LIMITED",
    "SUPPORT_UNSUPPORTED",
    "beginner_host_ids",
    "get_host",
    "host_capability_matrix",
    "host_summaries",
    "hosted_runtime_ids",
    "list_hosts",
    "recommended_host_id",
    "skill_host_ids",
]
