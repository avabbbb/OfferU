---
name: offeru
description: Connect an external Agent to the installed OfferU Career OS, ground work in canonical career context, and use governed operations without booting the development stack.
user-invocable: true
argument-hint: "[goal | JD/URL | skill-id]"
---

<!-- generated: offeru-skill-registry@2026-09-28.1 sha256=68ad2024af8dbe14ecadf581d952c512f8ccceb64b2927a7dc544861b9b62c1c -->

# OfferU — installed-product Agent router

OfferU Skill provides career workflow knowledge and routing. **The installed OfferU application owns runtime, data, permissions and durable career state.** A normal user request must connect to the installed product; it must not turn into an OfferU source-development session.

## Fast path — normal user first

1. Use the OfferU Skill already discovered by this Agent.
2. Prefer the runtime-specific projection supplied by the installed OfferU app. It contains the bundled command for this installation and can be used from any directory.
3. If this copy still contains `python -m app.cli`, treat it as the public/source bootstrap projection. For a normal career task, **do not execute those source commands yet**. First read the running app's projection at `http://127.0.0.1:8766/api/agent/runtime/skill`.
4. If the installed runtime is unavailable, tell the user in one sentence to open/install OfferU Desktop, then retry. Do not clone OfferU, search for its repository, create a Python environment, start Vite/FastAPI, or guess a checkout path.
5. Only enter source/developer mode when the user explicitly asks to develop, debug or contribute to OfferU itself.

The canonical public Skill is `https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md`. It is the distribution/bootstrap source, not a reason to run the repository.

Install only `offeru/SKILL.md` in a documented user-level Skills directory. Prefer `~/.agents/skills/offeru/SKILL.md` when the active Agent supports it; otherwise use that Agent's documented user-level location. Do not change Agent account/login, model, credentials, proxy, unrelated settings or project files just to make OfferU work.

## Connect and discover capabilities

After an installed/runtime-specific projection is available, run the projected command surface:

```powershell
python -m app.cli doctor --pretty
python -m app.cli manifest --pretty
```

In an installed projection, OfferU rewrites `python -m app.cli` to the bundled executable for that installation. In source/developer mode it remains the source CLI.

Read `skill_registry.skills`, choose the smallest Skill that matches the user's goal, fetch it with:

```powershell
python -m app.cli manifest --skill <skill-id> --pretty
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

Work from `backend/` **only when the user explicitly asked to develop/debug/contribute to OfferU and this session is operating in an OfferU source checkout**. In that case the source CLI commands above are valid. A normal job-search request is never sufficient reason to start the development frontend/backend.

## Control rules

- Run one atomic Operation per CLI invocation.
- Read Operations execute directly. Side-effect Operations persist a proposal/HITL decision instead of silently mutating protected state.
- Prepare safe artifacts proactively when the selected Skill permits it; do not make the user name internal Skills or repeatedly ask "what next?".
- Never use raw HTTP for OfferU business data/Operations, direct SQLite/database writes, removed routes, or hidden shell business logic.
- Never auto-submit applications, send email/messages, contact third parties or approve your own protected proposal.
- Never claim work is "ready/prepared" unless the corresponding durable OfferU artifact/proposal actually exists.
- Report durable outputs, pending decisions and real blockers; keep internal runtime/database details out of normal-user explanations.
