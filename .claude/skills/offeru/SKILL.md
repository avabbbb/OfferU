---
name: offeru
description: Use when operating OfferU through Claude Code. Provides live Skill discovery, atomic CLI operations, and human-confirmed side effects.
user-invocable: true
argument-hint: "[skill-id | goal | JD/URL]"
---

<!-- generated: offeru-skill-registry@2026-07-30.2 sha256=a7c8cbe3d1b4d1f733cf9756a014397236478b490348c7622ab965b020378f99 -->

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
