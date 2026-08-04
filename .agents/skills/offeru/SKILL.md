---
name: offeru
description: Use when operating OfferU through Codex or another agent-skill host. Provides live Skill discovery, atomic CLI operations, and human-confirmed side effects.
user-invocable: true
argument-hint: "[skill-id | goal | JD/URL]"
---

<!-- generated: offeru-skill-registry@2026-07-30.2 sha256=957035a716332bfbd23491e55a0637822ce7eb4f07f0c8038aa9c2c4662397bb -->

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
