---
name: offeru
description: Career OS context and safe operations for external agents; compose with installed resume, recruiting, interview, and career Skills.
user-invocable: true
argument-hint: "[skill-id | goal | JD/URL]"
---

<!-- generated: offeru-skill-registry@2026-10-04.1 sha256=735bbc552beaebe0d36a62deb93dd6d23bed562fdbe38af118c3d9a8581bb1b9 -->

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

If `tool_contract.connection_verification` contains a pending challenge for this connection, first select `connection_bootstrap` and read `get_current_view`, then select `connection_probe` and call `get_agent_connection_nonce` with the supplied `provider_id` and `challenge_id`. Return the readback and wait; this check does not authorize reading Profile or launching a career task. The host's brand is irrelevant to this contract.

## Career context and results

Career Truth, curated Career Memory, learning candidates and conversational memory remain distinct. Read minimum-sufficient canonical context for the user's goal and current page; host memory cannot silently become verified evidence. Resume changes need source evidence and a rationale for every material rewrite. Persist drafts, artifacts and proposals to the existing Job Workspace/Resume/Today surfaces; a chat answer alone is not completed work.

## Collaborate through the active Agent

Use the same OfferU Skill and live Tool Contract in any compatible host. Choose tools by their actual availability, not the Agent's brand. The user's already-open Agent owns reasoning, account/model configuration and its native interaction. Do not start another Agent or a hosted runtime as a prerequisite for this Skill. A Skill file alone is not a verified tool connection.

Keep doctor, manifest, schema and individual tool calls as internal setup. Explain progress in career terms: the role's priorities, available evidence, draft changes, pending review and the next useful action. Report connection failures with the failed step; do not silently switch reasoning providers.

### Refresh reality before advising

For current jobs, companies, products, hiring processes, compensation or market information, use the host's available web/search tools before drawing conclusions. Prefer official sources, follow up on material claims and contradictions, and preserve exact source URLs and retrieval dates with the research result. Distinguish the saved Job snapshot from newly retrieved information. Do not send private Profile/resume content in public search queries.

If native web is unavailable, inspect the selected live Skill for an appropriate research Operation. Respect its authorization and asynchronous result state; a pending proposal or queued task is not completed research. If neither path works, explicitly mark the information unrefreshed and continue only with conclusions supported by available evidence. Connection/bootstrap verification needs only its specified readback, not web research.

### Ask at career decision boundaries

When preferences, positioning or material trade-offs would change the result, call the active host's native structured input tool (such as ask, AskUserQuestion or request_user_input). Present one concrete decision with a recommended option and its trade-offs, wait for the answer, then continue. Do not replace an available native Ask tool with a chat-only question. Do not ask for facts OfferU can read, repeat an already answered decision or ask permission for each internal read/tool call.

If this execution context cannot interact (including a delegated or headless run), return a needs-user-input result to the parent/user surface with the question and options. Use an authenticated Desktop interaction tool only if actually exposed by the live contract; otherwise present the question in chat and wait. Never invent an Ask Operation or pretend a question was answered.

### Tailor a resume around decisions and section comparisons

Read the canonical Profile/evidence and target Job first. Ask about positioning and structure when unresolved: product/technical emphasis, section order, and which work, projects, games or open-source experiences to emphasize, compress or omit. Prepare section-level Before/After comparisons with the target requirement, original evidence references and rationale for every material rewrite. Keep the comprehensive Profile as the evidence source; tailoring a Job resume does not authorize changing Profile truth.

Proposals are adopted through `propose_resume_decision_plan`: after the proposal is persisted and workspace-bound, call it once with the pending `change_ids` arranged into a small set of meaningful semantic groups (typically 3-7: e.g. positioning summary, core experience, skills/projects, education/certifications). Each group becomes one v2 ConfirmationGroup executing one atomic batch `review_resume_proposal_items` accept node — never one group per bullet and never a bundle you invent. Express ordering (e.g. summary before dependent sections) with `dependency_indices`, and put the shown rationale in each group's `display`. After the plan is created, stop: the run pauses for the user's independent group approvals; you never approve, execute or pre-resolve them yourself.

When the live contract exposes `prepare_proposal_plan`, stage the current Run's prepared protected changes together: supply schema-valid Operation intents and explicit semantic groups whose `node_ids` reference those intent IDs. Bind the existing Run; do not start another reasoning session. For resume adoption, use `review_resume_proposal_items` with the exact displayed `change_ids` rather than one write per bullet. OfferU seals the actual changes and source versions, then the user approves a ConfirmationGroup through the independent Desktop review. An Ask answer is not that approval. Read `get_proposal_plan` / `list_proposal_plans` for persisted execution receipts; when a host cannot resume proactively, the original Agent reads them back and continues the same task. Do not call confirm/reject endpoints, the CLI confirm command, or fabricate a human decision. A paused or uncertain group requires safe recovery, not restaging the same unknown-effect mutation to obtain a new business key.

For external drafting, select `tailor_resume`, read `get_resume_preparation_context`, and keep its `source_fingerprint` unchanged. Submit your own draft once with `persist_external_resume_proposal`: use a stable `request_id`, `preparation.job_id`, `source_fingerprint`, `rows` shaped like `baseline_rows`, and `rationale` entries containing verified `source_section_ids`, a literal JD `requirement` excerpt and `why`. Store real Ask answers as `user_decisions` with `question` and `answer`; they remain strategy, not Profile facts. Changing a submitted payload requires a new request ID. Returned fact-gate errors or excluded rows go back to the same external Agent for repair; do not ask an embedded model to rewrite them. Bind the proposal with `ensure_resume_workspace` and read it with `get_resume_workspace`. These L1_prepare tools save reviewable drafts and do not adopt content. The user reviews section comparisons and adopts them in OfferU.

Ask answers establish preferences; they are not permission to self-confirm pending proposals or approve unseen rewrites. When a tool result contains a v2 `plan`, the run pauses for user group approvals — continue only from real results after the user acts, never by approving on their behalf. Adoption remains an independent user review of the concrete comparison in OfferU, with fact gates, stale-version checks and audit preserved. New Profile facts and external submit/send/contact require their own applicable review/authorization. Report prepared, pending, adopted and failed results accurately.


## Shared business methods

After selecting a live Skill, read its method relative to this installed `SKILL.md` directory. These are the same versioned assets used by the embedded Agent. A method does not add Operations or grant permissions. If the linked file is missing, report the missing method and update the OfferU connection; do not invent its workflow.

- `company_research`: [skills/research/SKILL.md](skills/research/SKILL.md), version 1.0.0, sha256 `8f73dd713fc5956eeb917ea21ecb85bdbfa8ec27ea11ac2c9c9b534a49cb7091`
- `profile_onboarding`: [skills/profile_onboarding/SKILL.md](skills/profile_onboarding/SKILL.md), version 1.0.0, sha256 `170c606c1314077d6ea3793318f2d7b491c1c2369f9090b252a97be236452256`
- `role_intelligence`: [skills/research/SKILL.md](skills/research/SKILL.md), version 1.0.0, sha256 `8f73dd713fc5956eeb917ea21ecb85bdbfa8ec27ea11ac2c9c9b534a49cb7091`
- `tailor_resume`: [skills/tailor_resume/SKILL.md](skills/tailor_resume/SKILL.md), version 1.0.0, sha256 `d86c2d8f1b7cacc0dd82620a41cc1c0704de7feb3c3b1c66a1b186ceb0f7d9f0`

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
- Read Operations and schema-marked L1_prepare Operations execute directly. Operations with requires_confirmation persist a proposal and do not execute immediately.
- Use `--dry-run` when a preview is useful. Dry-run is not confirmation.
- Leave adoption, truth-write and external-action proposals pending for the user to review and confirm in OfferU.
- Never use raw HTTP, direct database writes, removed `api/routes` commands, or hidden shell business logic.
- Never submit applications, send emails, or contact third parties automatically.
- Report executed reads, persisted proposals, pending confirmations, visible failures, and the next user decision.
