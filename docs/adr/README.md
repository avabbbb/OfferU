# OfferU Current Architecture Decisions

Status: **CURRENT DECISION SUMMARY**  
Updated: 2026-09-23

This file intentionally does **not** maintain a long numbered ADR ledger.

OfferU accumulated many historical ADRs while moving through built-in Agent, Pi, DSH, Codex-first and external-Harness-first designs. Keeping every historical decision in the default Agent reading path creates unnecessary context and contradictory instructions.

The complete pre-2026-09-23 decision history is preserved at:

- [Historical ADR ledger](../archive/architecture/adr-history-pre-2026-09-23.md)

## Current stable decisions

### Product shell

OfferU Desktop is the primary Career OS experience.

External Agent applications may remain the user's preferred reasoning environment, but OfferU is not required to embed itself inside a Harness UI. Host-native integrations and companion surfaces are optional integration strategies, not the product shell authority.

### Reasoning

Prefer a verified local Agent already owned by the user. A built-in OfferU Agent is allowed as fallback. Exactly one reasoning authority is active per Agent Run.

No reasoning engine owns Career Truth or its own approval policy.

### Career Truth

Python Career Runtime is the canonical source of truth for Profile, Evidence, Job, Application, Resume, Interview, Timeline and durable Memory state.

UI, Agent, browser extension, email sync, automation and Skills project or propose changes to that same truth; they do not create parallel state.

### Operations and approval

Governed business actions pass through the Operation Registry. Protected side effects use Proposal/HITL, idempotency and audit. An Agent cannot approve its own protected mutation.

### Tool discovery

The Operation Registry is broader than the Agent-facing tool catalog.

~~~
Skill metadata
→ active Skill
→ only relevant Operation schemas
~~~

The full Registry is a developer/audit surface, not a model menu.

### Skills

OfferU is composable with other installed Agent Skills. Third-party resume, recruiting, interview, negotiation or career-coaching Skills may provide methodology, drafting and critique. OfferU remains authoritative for canonical state, permissions and persistence.

### Job acquisition

The beginner default is explicit current-page capture from the browser. Background crawling, reverse-engineered source APIs and bulk collectors are advanced/research paths, not the normal consumer onboarding requirement.

### External actions

OfferU may prepare, preview and safely fill, but final irreversible external actions remain user-controlled unless a future product decision explicitly changes that boundary.

### Progress sync

Email and other channels create evidence/signals and reviewable progress candidates. They do not silently overwrite application stage.

### Product interaction

Default experience is Guided:

~~~
Career State
→ Next Best Action
→ user chooses/confirms
→ Agent/Operation executes
→ state updates
→ next action recalculates
~~~

Do not make beginner users learn a command taxonomy.

### Release shape

Normal users should receive native installers and should not need Python, Node, Git, MCP or CLI setup. Use existing local-Agent authentication when possible rather than duplicating API-key setup.

## Historical decisions

Historical ADRs remain useful for understanding why code exists. They do not override this file, the Current Product North Star, CONTEXT.md or ARCHITECTURE.md.

Do not add a new numbered ADR for every implementation adjustment. Add a durable decision here only when it changes a long-lived boundary; keep implementation notes in the relevant architecture or product document.