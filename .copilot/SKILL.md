---
name: offeru
description: Career OS context and safe operations for external agents; compose with installed resume, recruiting, interview, and career Skills.
user-invocable: true
argument-hint: "[skill-id | goal | JD/URL]"
---

<!-- generated: offeru-skill-registry@2026-07-30.2 sha256=aaed3fc9f2d46ef3564d49f1a20fdd408c03779eea2554b710b7274118406f23 -->

# OfferU External-Agent Router

Work from `backend/`. The live CLI manifest is the source of truth; this generated file contains no business workflow definitions.

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

When OfferU asks for integration verification, select the live `connection_probe` Skill, inspect `get_agent_connection_nonce`, execute it with the supplied `provider_id` and `challenge_id`, and return the nonce unchanged. Never read challenge storage directly or guess a nonce.

## Control rules

- Run one atomic Operation per CLI invocation with `python -m app.cli run <operation>`.
- Read Operations execute directly. Side-effect Operations persist a proposal and do not execute immediately.
- Use `--dry-run` when a preview is useful. Dry-run is not confirmation.
- Leave side-effect proposals pending for the user to review and confirm in OfferU.
- Never use raw HTTP, direct database writes, removed `api/routes` commands, or hidden shell business logic.
- Never submit applications, send emails, or contact third parties automatically.
- Report executed reads, persisted proposals, pending confirmations, visible failures, and the next user decision.
