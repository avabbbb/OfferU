
# OfferU Current Product North Star

Status: **CURRENT PRODUCT AUTHORITY**  
Updated: 2026-09-23

This document defines the current product shape of OfferU. Historical audits, dated implementation plans and superseded Harness-specific designs must not override it.

## Product promise

OfferU is a **local-first AI Career OS** for normal job seekers.

It should reduce both:

1. **setup burden** — users should not need Python, Node, Git, MCP, CLI, model IDs or provider configuration to start;
2. **decision burden** — users should not need to know which feature, mode, Skill or Agent command to invoke next.

The default experience is:

~~~
Install
→ Find my local AI automatically
→ Resume + explicitly authorized AI memory → Profile
→ Save a real job from the browser
→ Connect a job-search inbox
→ Today tells me the next best actions
→ Agent prepares / analyzes / drafts
→ User confirms important facts and irreversible actions
→ outcomes feed back into Profile and future decisions
~~~

## Product information architecture

The stable top-level product model is:

~~~
Today
Pipeline
Job / Opportunity
Profile
~~~

- **Today** is the guided action layer. It answers “what matters now?” and shows at most a few primary actions.
- **Pipeline** projects application state, timeline and next action from the same canonical events.
- **Job** contains role understanding, evidence gaps, resume/application material and interview preparation for one opportunity.
- **Profile** is the long-lived evidence-backed model of the user. Memory is an evolution mechanism for Profile, not a separate silo.

Agent, Skills, Email, Browser Capture, Resume, Role Intelligence and Interview are capabilities across these surfaces, not competing top-level products.

## Reasoning authority: external-first, not external-only

OfferU prefers a **verified local Agent already owned by the user** — for example Codex, WorkBuddy/CodeBuddy, Claude Code, OpenCode, OMP, Pi or another supported host.

OfferU should:

- discover supported local hosts;
- use their native login, model configuration and account where possible;
- avoid asking normal users to duplicate API keys;
- project the OfferU Skill and the smallest relevant tool surface;
- preserve the host's native session/model lifecycle when that host is acting as the reasoning engine.

A built-in OfferU Agent is allowed as a **fallback** when no suitable external host is available or when the user explicitly chooses it.

Exactly one reasoning authority is active for a given Agent Run. External and built-in Agents share the same truth, capability, confirmation and audit boundaries.

~~~
Reasoning authority
  external local Agent (preferred)
  OR OfferU fallback Agent
          ↓
OfferU Skill + optional third-party Career Skills
          ↓
Operation Registry
          ↓
Career Runtime
          ↓
Local Career Truth
~~~

No Agent owns Career Truth and no Agent may approve its own protected mutation.

## Agent Skills ecosystem

OfferU participates in the open Agent Skills ecosystem instead of reimplementing every career methodology.

The host may compose:

~~~
OfferU Skill
+ resume / recruiting / interview / negotiation / career-coaching Skills
~~~

The division of responsibility is strict:

- third-party Skills may provide methodology, analysis, critique, coaching and drafting;
- OfferU provides canonical Profile / Evidence / Job / Application / Interview context;
- third-party Skill output enters OfferU as analysis, draft or candidate material;
- persistent state changes still use the Operation Registry and normal review boundary;
- third-party Skills cannot auto-submit, send messages, expose secrets, write the database directly or promote inference into verified career facts.

OfferU does not need to scan or execute arbitrary Skill folders itself just to gain composability. Prefer the Agent host's native Skill discovery; any future OfferU Skill Inventory should be metadata-only by default and explicitly permissioned.

References:
- https://agentskills.io/
- https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

## Guided interaction

The default mode is **Guided**.

OfferU should observe canonical Career State and recommend the **Next Best Action** instead of presenting an empty dashboard or a menu of Agent modes.

Rules:

1. show at most three primary actions;
2. explain **why now**;
3. do not ask for information OfferU already knows;
4. ask one progressive-profile question only when it improves a current decision;
5. after an action completes, recalculate the next actions;
6. advanced Agent/Skill/CLI controls remain available but are not required for normal use.

Power users may still use direct Agent chat, Skills, CLI and batch workflows.

## Progressive Profile

Do not front-load a giant onboarding form.

T0 should require only enough information to create value, primarily a resume/core experience and target direction. Later, OfferU asks small contextual questions when they unlock a real decision.

New information follows provenance rules:

~~~
Resume / User statement / authorized Agent memory / Email / Interview
→ observation or candidate
→ review / evidence gate
→ verified Profile state when appropriate
~~~

Authorized local-Agent memory is useful input, but it is not automatically Career Truth.

## Job capture

The default beginner flow is user-triggered current-page capture:

~~~
User opens a job page
→ browser extension reads the active page after explicit user action
→ preview / dedupe
→ Save to OfferU
~~~

This is not background crawling and not an application event.

BOSS CLI, scraper adapters or other source connectors may exist for research, testing or advanced user workflows, but they are not the default consumer acquisition path and must not weaken platform, privacy or anti-automation boundaries.

## Application assistance

OfferU may help prepare and fill an application, but the normal safety boundary remains:

~~~
OfferU prepares
→ user reviews
→ safe fields may be filled after confirmation
→ user performs the final external submit
→ OfferU may capture a receipt candidate afterward
~~~

No silent final submit.

## Progress sync

Email and other authorized channels are evidence sources, not direct Pipeline writers.

~~~
Email / authorized signal
→ classify + associate
→ ApplicationProgressCandidate
→ user/policy review
→ ApplicationStageEvent
→ Pipeline / Today update
~~~

Background analysis may be proactive. Canonical stage changes must remain explainable and auditable.

## Authority model

~~~
Reasoning = active Agent
Execution / capability = Operation Registry
Truth = Career Runtime
High-risk approval = User / explicit product policy
~~~

All product surfaces converge on those authorities.

## Current implementation direction

Recently landed on main:

- Assisted Apply / ApplicationActionConnector foundation (#14);
- Tool Surface V2 separating the governed Operation Registry from the model-facing tool catalog (#17);
- Guided Today actions and composable local career-Skill contract (#19).

Current active validation work:

- real OMP/RPC Agent Eval (#16, still draft/open).

The previous zero-setup proposal (#18) is incorporated into this North Star; this document is the current product authority.

## Non-goals

Do not reintroduce these as defaults:

- Harness UI as the mandatory primary product shell;
- a DSH-first or Codex-only product architecture;
- a second Career Truth store;
- an Agent-specific database write path;
- a giant all-Operations tool catalog;
- duplicate provider/API-key setup when a local Agent already has working auth;
- background job crawling as the beginner job-capture path;
- silent application submission or recruiter messaging;
- a long command/mode menu as the beginner UX;
- treating historical eval/audit numbers as current capability truth.

## Success test

A new user should be able to understand OfferU without knowing what a Harness, MCP server, Operation Registry or provider is.

The product is succeeding when the user experiences:

~~~
OfferU knows my current career state
→ tells me what matters next
→ uses the AI I already have
→ safely composes the Skills I already have
→ prepares work proactively
→ asks me only for decisions that genuinely require me
→ learns from confirmed outcomes
~~~
