
# OfferU Current Product North Star

Status: **CURRENT PRODUCT AUTHORITY**  
Updated: 2026-10-02

This document defines the current product shape of OfferU. Historical audits, dated implementation plans and superseded Harness-specific designs must not override it.

The owner's 2026-10-02 acceptance clarification is defined in [Real job-seeker journey](./owner-career-journey.md): progressive setup with a visible evidence-backed Profile; fresh research for current-world claims and native Ask for material user decisions; explainable job ranking; shared role research for resume and interview work; section-level review; real debrief learning; and distinct refresh/reset/history-distillation routes. These are product requirements, not claims of completed implementation. Run the [two dogfood Goals](../evals/OWNER_DOGFOOD_GOALS.md) and retain explicit gaps.

## Product promise

OfferU is a **local-first Career OS for people who already use a general-purpose Agent**: university students, graduate students and experienced job seekers who value application quality and efficiency and are willing to invest in them. Bring Your Own Agent is a core product mode, covering both Coding and consumer Agents; users need not be programmers.

The category is broad; the first-use promise should be concrete:

> **Give OfferU a job. It shows what the role really asks for, what you can prove, and prepares the application around that evidence.**

The core product equation is:

~~~
Target Job
    ↓
What does this role care about?
    ×
What can I actually prove?
    ↓
What should I prepare next?
    ↓
Evidence-backed Job Workspace
~~~

OfferU should reduce both:

1. **setup burden** — users should not need Python, Node, Git, MCP, CLI, model IDs or provider configuration to start;
2. **decision burden** — users should not need to know which feature, mode, Skill or Agent command to invoke next.

The default experience is:

~~~
Install
→ Open Desktop
→ Resume + explicitly authorized AI memory → Profile
→ Save a real job from the browser
→ Create the canonical Job Workspace
→ Agent prepares / analyzes / drafts into that Workspace
→ Today tells me what needs attention next
→ User confirms important facts and irreversible actions
→ outcomes feed back into Profile and future decisions
~~~

Desktop discovers the user's local Agent, installs/updates the runtime-bound Skill through its host adapter and verifies a real read-only Operation. Consumer Agents use officially supported connectors when actually available. Connecting an Agent is central to the product but is not a gate before Profile/Job value. Normal users do not copy connection prompts, hand-install Skills or start a source environment.

The user should experience a durable workspace, not a disposable AI conversation.

## Product information architecture

The stable top-level product model is:

~~~
Today
Pipeline
Job Workspace
Profile
Resume
Interview
~~~

- **Today** is the guided action layer. It answers “what matters now?” and shows at most a few primary actions. Opening Today records one idempotent daily Career Director review for the default Profile; the resulting CareerBriefing is projected into Today and the existing Automation Inbox, while the CareerTask remains the durable execution record.
- **Pipeline** projects application state, timeline and next action from the same canonical events.
- **Job / Job Workspace** is the durable application workspace for one opportunity: Job Snapshot, Role Intelligence, Evidence Map, application materials, interview preparation and canonical Timeline all converge here. Saving a Job triggers one bounded Career Director assessment against current Career State; the plan is persisted in CareerTask/Automation Inbox and displayed in this workspace. Role Intelligence is offered only when the assessment recommends it, and starts only after the user chooses it. Agent conversations are only one way to modify this workspace.
- **Profile** is the long-lived evidence-backed model of the user. Memory is an evolution mechanism for Profile, not a separate silo.

Agent, Skills, Email, Browser Capture, Resume, Role Intelligence and Interview are capabilities across these surfaces, not competing top-level products.

Saving a Job and opening its canonical workspace must work when the embedded Agent or active model configuration is unavailable. OfferU keeps the Job and workspace available, records a retryable blocked CareerTask, and explains what needs configuration. It does not replace Career Director reasoning with a scripted assessment. Role Intelligence is not started by `JOB_SAVED`; a valid recommendation is policy-checked and offered as a user-started Registry operation.

## Distribution and first-use contract

For normal users, OfferU Desktop owns setup. The intended public beginner experience is:

~~~text
Download OfferU
→ install
→ open OfferU
→ import Resume
→ save first Job
→ useful Job Workspace
→ connect the user's Agent through Desktop / supported connector when needed
→ verify access with a real read-only Operation
~~~

The normal user must not be required to install Python, Node.js, Git, MCP tooling or hand-copy Skill files. Desktop discovers supported installed hosts and owns the runtime-bound Skill installation/update. Detected, installed and verified are separate evidence states. The Agent keeps ownership of its account/login/model; host adapters never duplicate career business logic.

Skill-first remains a valid second front door. OfferU does not claim a published standalone `npx skills add offeru` package; the canonical Skill is the `main` branch file in the public GitHub repository at `https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md`, while the local Desktop runtime serves only an installation-specific CLI projection.

Detailed first-use, current host/capability boundaries and owner-dogfood acceptance are maintained in [Entry, Onboarding & Dogfood Contract](./entry-onboarding-and-dogfood.md).

## Two front doors, one Career Truth

OfferU has two valid entry lanes that must converge on the same canonical state.

### Normal user: App-first

The target audience includes university students, graduate students and experienced job seekers who already use a general-purpose Agent and are willing to invest in application quality and efficiency. Their Agent may be a local Coding Agent or a consumer chat/Agent product. Audience coverage does not imply every host can directly access the local Runtime.

Local tool-capable Agents use the canonical Skill and verified Operation readback. Chat-only users can copy material-collaboration instructions, deliberately share the minimum job/evidence material with their chosen Agent, and review its drafts before saving adopted content through existing OfferU UI operations. This manual lane is not a verified connection, an automatic data export or an Agent Run. Direct cloud connectors remain unavailable until their host-specific transport and authorization are implemented and accepted; never ask a cloud Agent to reach its own localhost as if it were the user's computer.

~~~
Install OfferU
→ open Desktop
→ import resume / core evidence
→ save first Job
→ open Job Workspace
→ Guided Today handles the next decisions
~~~

Use Desktop's Agent connection action when needed; compatible consumer connectors use their official authorization surface. Do not replace unsupported native consumer chat with a pretend embedded conversation. The bottom/context interaction binds the current Job, Resume, Interview or Today and shows canonical tasks, results and approvals.

### Power user: Skill-first

A user already inside Codex, Claude Code, WorkBuddy/CodeBuddy, OpenCode, OMP, Pi or another supported host may start from the Agent:

~~~
enable OfferU Skill
→ "analyze this job for me"
→ Agent creates/resolves the canonical Job
→ governed OfferU operations prepare the role
→ open the same Job Workspace in OfferU
~~~

This must never become a second CLI-only product. Skill-first and App-first are two doors into the same Career Runtime, Job, Pipeline, Profile and audit trail.

## Reasoning authority: external-first, not external-only

OfferU prefers the **general-purpose Agent already owned by the user**, through a verified supported connection. Local Coding Agents and consumer Agents are both core target hosts; public vendor capability is distinct from an implemented and accepted OfferU adapter.

OfferU should:

- discover supported local hosts;
- use their native login, model configuration and account where possible;
- avoid asking normal users to duplicate API keys;
- project the OfferU Skill and the smallest relevant tool surface;
- preserve the host's native session/model lifecycle when that host is acting as the reasoning engine.

A built-in OfferU Agent is allowed as a **fallback** when no suitable external host is available or when the user explicitly chooses it.

The built-in Agent remains capable of operating OfferU and assisting with job-tailored resumes through the same Skill allowlists, source evidence, fact gates, draft/proposal path and independent approval. This is one selectable reasoning provider, not a second competing write loop or a weaker permission model.

Exactly one reasoning authority is active for a given Agent Run. External and built-in Agents share the same truth, capability, confirmation and audit boundaries.

~~~
Reasoning authority
  user's connected general-purpose Agent (preferred)
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

## Job Workspace as the durable product object

The unit of work is not a chat transcript. For every target opportunity, OfferU should materialize a persistent, reviewable Job Workspace:

~~~
Job Workspace

Job Snapshot
Role Intelligence
Evidence Map
Application Materials
Interview
Timeline / Next Action
~~~

The Workspace progressively fills as work completes:

~~~
Job saved
→ Job Snapshot ready
→ Career Director assessment completed or visibly blocked
→ user-selected Role Intelligence / Evidence Map / Resume preparation
→ interview preparation when a real interview is scheduled
~~~

Long-running Agent work should surface as product state: completed, needs review, blocked/failed, and next action. Closing an Agent chat must not make the work disappear.

Accepted facts, user edits and approved versions are preserved. Re-analysis may update affected preparation, but it must not reset unrelated application state or silently overwrite accepted work.

## Proactive Career Director

Guided UX must not mean “the user still has to know what to ask the Agent”.

For normal users, OfferU should proactively interpret meaningful Career State changes and decide what deserves attention next.

The accepted architecture remains the single durable automation model:

~~~text
Event / Schedule / Career State change
→ explicit Runtime trigger
→ Career Snapshot
→ bounded Career Director reasoning
→ Strategy Pack
→ Proactive Plan
→ Autonomy Policy
→ CareerTask / Proposal / Today / Inbox
→ Operation Registry
→ Career Truth
~~~

This does **not** introduce a second infinite Agent loop. Runtime decides **when to think**; the model decides **what matters and which governed capability is appropriate**; Operation Registry and product policy decide **what may execute**.

OfferU must distinguish at least campus/fresh-graduate and experienced-hire strategy. Profile sufficiency, Today ranking, interview preparation, re-engagement and follow-up are target- and stage-relative rather than one generic checklist.

The Director may automatically observe/analyze and prepare bounded drafts. Runtime validates each proposed action, target, evidence reference, Operation, Skill and autonomy level against the current Registry-backed policy context and source fingerprint. It may not self-confirm protected Career Truth changes or irreversible external actions.

When an interview is added to the canonical calendar or recovered from an interview notification, OfferU triggers a bounded Career Director run that reads the current Career Snapshot, linked Job preparation and reviewed interview learning. The resulting preparation plan appears in Today and the same Job Workspace. After a scheduled interview passes, Daily Review creates one debrief task with model-selected questions; submitted answers remain source-linked learning candidates until the user reviews them in the memory inbox. Neither preparation nor debrief writes verified Career Truth or contacts anyone.

Saving a new Resume version with added evidence triggers one bounded re-engagement review against active applications that used an older version. The Career Director judges whether the new evidence changes the case; any positive candidate appears in Today and the canonical Job Workspace for review. OfferU never sends a recruiter message from this trigger.

Detailed design, autonomy levels, Strategy Packs and eval cases are defined in [Proactive Career Director](./proactive-career-director.md).

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

## Plan → Review → Execute

Before a large preparation run, paid model work, or any external side effect, OfferU should show a compact plan at the level a normal user cares about:

- what will be researched or generated;
- which verified evidence will be used;
- what is only a proposal;
- which external actions will **not** happen automatically;
- account / rate / estimated cost when materially relevant and known.

This is not approval-everywhere. Work already inside an agreed safe scope may proceed; a material change of scope, cost, account or irreversible effect creates a new decision.

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

Fit Check shows requirement-by-requirement evidence, hard requirements and unknowns; an unexplained aggregate score is not its decision authority. Application materials, questions, approvals and receipts aggregate in the existing Job Workspace. Do not add a parallel Opportunity, Application Packet database or application lifecycle. A submit click or Agent claim is not a receipt: Pipeline advancement requires attributable success evidence, existing deduplication and stage-event policy.

L0 observe and authorized L1 preparation may progress within a bounded task. L2 protected Career State changes use Proposal/HITL. L3 sending, submission and contact require the existing explicit authorization policy; field filling is classified by its actual side effects and sensitivity, not automatically L2. The current default keeps final external submission with the user. Broader automation needs separately implemented bounded grants, expiry/revocation, receipts, audit and a pause control.

## Host-neutral access and contextual interaction

[OfferU Tool Contract](../architecture/agent-tool-contract.md) projects one Registry, Career Truth, curated Memory, Proposal/HITL and audit across local Skill/CLI/MCP and officially supported remote connectors. Host adapters only handle discovery, authentication, grants, tool registration and capability negotiation. They do not implement career business logic.

The bottom Agent interaction binds Today goals/tasks/approvals, current Job requirements/materials/progress, Resume and version/review context, or Interview schedule/preparation/debrief. Results enter existing pages. OfferU may display managed tasks, results and approvals for any connected host; unsupported consumer-native chat is not embedded or represented as connected. Web Showcase retains Demo Agent and fictional data; Desktop offers the built-in Agent as an explicit fallback through the same governed operations.

Runtime alone schedules AutomationEvent → AutomationRule → CareerTask, owns leases, checkpoints, recovery and deduplication. The selected external Agent performs one bounded task and returns durable outputs; it must not create a second scheduler or infinite reasoning loop. Uncertain submission is reconciled against receipt evidence before retry. The existing Career Director and Strategy Packs remain this loop's career reasoning architecture.

Design target acceptance: real Codex reads Career Truth and authorized Memory, discovers suitable jobs, prepares evidence-backed resume drafts, and leaves review items visible in Today, Job Workspace, Resume and the independent review UI. Connection detection, a nonce readback, unit tests and replay are separate evidence layers and do not prove this complete scenario.

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
- Guided Today actions and composable local career-Skill contract (#19);
- canonical Job Workspace + App-first / Skill-first product authority;
- real OMP RPC Eval implementation on current main (the old #16 branch is superseded/closed; live Agent-native acceptance is still NOT_RUN);
- Zero-Setup onboarding implementation for Agent readiness → Resume/Profile → optional authorized memory → first Job → optional inbox → Today;
- permissioned Codex memory-summary import through the existing evidence/memory-proposal gate;
- macOS desktop packaging foundation for arm64/x64.

Current validation status is maintained in [STATUS.md](../../STATUS.md) and the [owner dogfood Goals](../evals/OWNER_DOGFOOD_GOALS.md). S0 precedes real Provider and Resume acceptance; this product contract does not declare those gates complete.

The older #29 build baseline and 2026-09-27 proactive implementation/live synthetic smoke are historical evidence. The latter is [distilled here](../archive/checkpoints/2026-09-27-proactive-career-director.md). Signing/notarization, clean-machine acceptance and genuine user journeys require their own current evidence.

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

## Product story and launch order

Product communication should start from the repeated user problem, not the internal architecture:

1. every application starts from zero;
2. the JD, resume, research, tracker and interview learning are fragmented;
3. generic AI can optimize by inventing unless evidence and truth are separately governed;
4. OfferU turns a target Job + verified Career Profile into one reviewable Job Workspace.

Recommended information order:

~~~
Concrete Job → Workspace outcome
→ complete Job-to-Workspace demo
→ Role × Evidence formula
→ why job-search AI breaks
→ Job Workspace
→ Quickstart
→ local Agent / Skill entry
→ Today / Pipeline / Profile compounding loop
→ evidence / approval model
→ architecture, security and release status
~~~

Operation Registry, Reasoning Authority and Career Runtime explain **why the experience can be trusted**; they are not the first reason a normal user cares.

## Success test

A new user should be able to understand OfferU without knowing what a Harness, MCP server, Operation Registry or provider is.

The product is succeeding when the user experiences:

~~~
I give OfferU a Job
→ it shows what the role cares about
→ maps that against what I can actually prove
→ prepares work into one durable Job Workspace
→ uses the AI I already have
→ tells me what matters next
→ asks me only for decisions that genuinely require me
→ preserves accepted work
→ learns from confirmed outcomes
~~~
