---
name: offeru
description: Career OS context and safe operations for external agents; compose with installed resume, recruiting, interview, and career Skills.
user-invocable: true
argument-hint: "[skill-id | goal | JD/URL]"
---

<!-- generated: offeru-skill-registry@2026-09-30.1 sha256=d8cc2af2626bea37d82c80b26ca832bd01aa56568cb3bdcc7936d1a1e550d88c -->

# OfferU — installed-product Agent router

OfferU gives your Agent professional career tools, evidence and memory. The installed application owns Career Truth, permissions and durable results; the active Agent reasons and drafts. Built-in and external Agents use the same Operations and review boundary.

<!-- offeru-runtime-binding -->

## Normal user: connect to the installed product

The canonical public Skill is `https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md`. It is a bootstrap contract, not a source-development command sheet. OfferU Desktop installs the executable binding and updates the runtime-bound Skill using the supported host adapter.

If `<offeru-cli>` below is unresolved and no authenticated OfferU connector is available, ask the user once to open OfferU Desktop and use **连接 Agent / 更新接入**. Do not execute the placeholder. Do not search for a checkout, install development dependencies, start servers, manually fetch localhost projections or ask the user to copy a connection prompt. Source development is allowed only when explicitly requested for developing/debugging OfferU.

For a consumer Agent, use only its officially supported and actually connected tool transport. A cloud Agent's localhost is not the user's computer. If no connector exists, state the limitation; manual material collaboration is not a verified connection.

Do not change Agent account/login, model, credentials, proxy or unrelated settings. Desktop installs only the OfferU-owned Skill and never overwrites another Skill. Start a fresh Agent session if required by host discovery.

## Start every task

```text
<offeru-cli> doctor --pretty
<offeru-cli> manifest --pretty
```

Read `skill_registry.skills` from the compact manifest, choose one Skill, then run `<offeru-cli> manifest --skill <skill-id> --pretty`. Inspect each selected Operation with `<offeru-cli> schema <operation> --pretty` before calling it. MCP/Connector hosts use the corresponding authenticated catalog/schema/invoke tools; transport does not change permissions.

## Career context and results

Career Truth, curated Career Memory, learning candidates and conversational memory remain distinct. Read minimum-sufficient canonical context for the user's goal and current page; host memory cannot silently become verified evidence. Resume changes need source evidence and a rationale for every material rewrite. Persist drafts, artifacts and proposals to the existing Job Workspace/Resume/Today surfaces; a chat answer alone is not completed work.

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

When Desktop requests a bootstrap readback, select the live `connection_bootstrap` Skill, inspect the `get_current_view` schema, and execute that read-only Operation once. Report only the current page and explicit selection, then wait. This bootstrap read does not authorize reading other career data.

When OfferU asks for integration verification, select the live `connection_probe` Skill, inspect `get_agent_connection_nonce`, execute it with the supplied `provider_id` and `challenge_id`, and return the nonce unchanged. Never read challenge storage directly or guess a nonce.

## Control rules

- Run one atomic Operation per CLI invocation with `<offeru-cli> run <operation>`.
- Read Operations execute directly. Side-effect Operations persist a proposal and do not execute immediately.
- Use `--dry-run` when a preview is useful. Dry-run is not confirmation.
- Leave side-effect proposals pending for the user to review and confirm in OfferU.
- Never use raw HTTP, direct database writes, removed `api/routes` commands, or hidden shell business logic.
- Never submit applications, send emails, or contact third parties automatically.
- Report executed reads, persisted proposals, pending confirmations, visible failures, and the next user decision.
