# OfferU Context

Status: **CURRENT DOMAIN AUTHORITY**  
Updated: 2026-09-23

OfferU is a local-first AI Career OS. This glossary keeps only concepts that should guide current product and Agent behavior.

Historical terminology is preserved in [the archived context](./docs/archive/architecture/context-pre-2026-09-23.md).

## Core authorities

**Career Runtime**  
The canonical domain runtime for Profile, Evidence, Jobs, Applications, Resumes, Interviews, Events and durable Memory state.

**Operation Registry**  
The governed execution surface for business capabilities. It owns validation, permission checks, side-effect classification, Proposal/HITL routing, idempotency and audit. The Registry is not identical to the Agent tool catalog.

**Reasoning Authority**  
The single active Agent for a given Agent Run. Prefer a verified local external Agent already used by the user; OfferU may provide a fallback Agent. The reasoning authority plans and selects capabilities but does not own Career Truth or approval.

**Agent Host**  
A local application/runtime capable of hosting the active Agent or OfferU Skill, such as Codex, WorkBuddy/CodeBuddy, Claude Code, OpenCode, OMP, Pi or another supported host. Detected does not mean verified.

**Agent Run**  
One auditable execution attached to a user goal. A Run records selected Skill, inputs, tool events, proposals, outputs and terminal state. Hidden model context is not Career Truth.

## Skills and tools

**OfferU Skill**  
The portable instructions that teach a compatible Agent host how to discover OfferU capabilities and respect OfferU's truth, permission and confirmation boundaries.

**Third-party Career Skill**  
An independently installed resume, recruiting, interview, negotiation or career-coaching Skill. It may contribute methodology or draft content but cannot directly mutate OfferU truth or weaken safety rules.

**Agent Tool Surface**  
The intentional subset of Registry Operations exposed to Agents.

**Active Skill Surface**  
The smallest task-specific set of Operations loaded after a Skill is selected.

**Capability Gap**  
A user goal for which no legal public OfferU Operation path exists, even assuming an ideal Agent.

**Tool Discovery Failure**  
A legal capability exists, but the active Agent fails to find or select it.

## Career truth and learning

**Career Profile**  
The long-lived, evidence-backed representation of the user's experience, achievements, skills, preferences and goals.

**Career Evidence**  
A fact or source-backed statement that can support resume, matching or interview work.

**Observation / Candidate**  
New information that may be relevant but is not yet canonical truth. Sources include resumes, user statements, authorized Agent memory, email, browser receipts and interview/debrief learning.

**Learning Observation**  
A reviewable signal produced by outcomes, user corrections, interview performance or repeated behavior. It can propose a Profile change but does not silently become fact.

**Progressive Profiling**  
Ask the minimum during onboarding and request additional information only when it helps a current decision.

## Job and application flow

**Job Capture**  
User-triggered import of the currently viewed job page into OfferU. It is not background crawling and does not mean the user has applied.

**Job Context**  
The opportunity-specific workspace containing the job, research/role signals, evidence gaps, resume/application material, application state, interview preparation and timeline.

**Application Attempt**  
One real application to a job/opportunity. Re-applying may create another attempt.

**External Progress Signal**  
An email or other authorized message that suggests something changed. It is evidence, not the stage itself.

**ApplicationProgressCandidate**  
A proposed progress interpretation awaiting review or an explicit safe policy decision.

**ApplicationStageEvent**  
The durable event representing a confirmed application-stage transition.

**External Submit**  
The user's irreversible action on a recruitment site. OfferU may prepare or fill safe fields, but does not silently perform final submit.

## Interaction model

**Today / Next Best Action**  
The guided projection of what matters now. It is derived from Career State and is not a second task truth store.

**Guided Mode**  
Default beginner experience. OfferU recommends at most a few high-value next actions and explains why they matter now.

**Power Mode**  
Advanced access to Agent chat, Skills, CLI, batch workflows and diagnostics. It must not be required for normal onboarding.

**Zero Setup**  
The user installs OfferU and reaches useful value without installing Python/Node/Git or manually configuring Agent protocols.

**Zero Figure-It-Out**  
The user does not need to understand which mode/Skill/tool to invoke next; OfferU proactively guides the next action.

## Safety vocabulary

**Proposal / HITL**  
A protected mutation pauses for review before execution.

**False Success**  
The Agent claims a task succeeded when trustworthy execution/outcome evidence does not show success.

**Protected State**  
Career records or external actions whose mutation requires explicit policy/confirmation safeguards.

## Product surfaces

The stable top-level surfaces are:

~~~
Today
Pipeline
Job / Opportunity
Profile
~~~

Agent, Email, Browser Capture, Resume, Interview and Memory are cross-cutting capabilities, not separate competing products.

For product behavior see [Current Product North Star](./docs/product/current-product.md).