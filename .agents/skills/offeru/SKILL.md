---
name: offeru
description: Connect an external Agent to the installed OfferU Career OS, ground work in canonical career context, and use governed operations without booting the development stack.
user-invocable: true
argument-hint: "[goal | JD/URL | skill-id]"
---

<!-- generated: offeru-skill-registry@2026-09-28.1 sha256=68ad2024af8dbe14ecadf581d952c512f8ccceb64b2927a7dc544861b9b62c1c -->

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

OfferU Desktop owns first-time verification. When the installed app requests a bootstrap check, select `connection_bootstrap`, inspect `get_current_view`, and execute that single read-only Operation. Report only the current page and explicit selection. **Do not ask the user to copy/paste a connection prompt.**

When OfferU Desktop requests the nonce verification step, select `connection_probe`, inspect `get_agent_connection_nonce`, execute it with the supplied `provider_id` and `challenge_id`, and return the nonce unchanged. Never read challenge storage directly or guess a nonce.

## Developer-only source fallback

Source/developer mode is permitted **only when the user explicitly asked to develop, debug or contribute to OfferU itself**. In that developer-only projection, OfferU may bind `<offeru-cli>` to a source CLI. Do not infer a repository path or working directory from this public Skill. A normal job-search request is never sufficient reason to start the development frontend/backend.

## Control rules

- Run one atomic Operation per CLI invocation.
- Read Operations execute directly. Side-effect Operations persist a proposal/HITL decision instead of silently mutating protected state.
- Prepare safe artifacts proactively when the selected Skill permits it; do not make the user name internal Skills or repeatedly ask "what next?".
- Never use raw HTTP for OfferU business data/Operations, direct SQLite/database writes, removed routes, or hidden shell business logic.
- Never auto-submit applications, send email/messages, contact third parties or approve your own protected proposal.
- Never claim work is "ready/prepared" unless the corresponding durable OfferU artifact/proposal actually exists.
- Report durable outputs, pending decisions and real blockers; keep internal runtime/database details out of normal-user explanations.
