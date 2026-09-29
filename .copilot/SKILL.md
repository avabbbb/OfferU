---
name: offeru
description: Career OS context and safe operations for external agents; compose with installed resume, recruiting, interview, and career Skills.
user-invocable: true
argument-hint: "[skill-id | goal | JD/URL]"
---

<!-- generated: offeru-skill-registry@2026-09-29.1 sha256=2a2f0657deef609c7c349241a2a14e35b4f5bde11affd1e872c89aca131588cd -->

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
