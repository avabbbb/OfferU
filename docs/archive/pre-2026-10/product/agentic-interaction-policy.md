> **已归档（2026-10）**：本文不再是当前权威。当前文档：02-interaction-design.md（位于 `docs/`）。

# Agentic Interaction Policy

Status: **CURRENT PRODUCT AUTHORITY**  
Date: 2026-10-06  
Scope: Desktop, embedded Agent, external Agent/Skill, Proposal/HITL, Today/Inbox, Resume/Job Workspace, recovery.

This document defines how OfferU decides **when the user should be interrupted**.

The governing rule is:

> **Scripts enforce invariants. Agents decide interaction. Humans decide materially consequential choices.**

OfferU must not force a normal user to understand its internal state machine, Skill IDs, Proposal internals, recovery states, database writes or work queues. The user expresses an outcome; the active Agent reads the current Career State, Memory, current surface and prior decisions, then selects the next useful action. Deterministic code enforces hard safety and data-integrity boundaries.

## Why this policy exists

The 2026-10-06 source review of `main@81bb08e` found several places where implementation state had leaked into user interaction:

- `Operation.requires_confirmation` was effectively derived from mutation type, so many low-risk writes became user approval work.
- Agent chat input was disabled while a Run had pending review, Ask or interruption state.
- creating a new conversation or loading another conversation could abort the active Run.
- stale/waiting technical states could occupy the same attention channel as genuine user decisions.
- router failures could ask the user to manually pick a Skill.
- Career Director policy mechanically required a user for every L2/L3 action.
- Resume review guidance prescribed multiple confirmation groups before asking whether they represented one user decision.
- structured Ask rendered every option as a checkbox, even when the decision was logically single-choice.

These are product-level interaction defects even when the underlying persistence, audit and security behavior is technically correct.

## Interaction decision model

Every candidate action is classified into one of five user-interaction outcomes.

| Outcome | Meaning | Default examples |
| --- | --- | --- |
| `AUTO` | Execute/prepare without interrupting the user. | reads, projection/cache updates, bounded research, draft materialization, reversible workspace preparation |
| `ASK` | Ask for missing preference/context that materially changes the result. | positioning, one of several mutually exclusive strategies, missing ambiguity the system cannot infer |
| `REVIEW` | Show a concrete proposed result for adoption/revision. | resume rewrite, Career Truth candidate, application-stage interpretation |
| `AUTHORIZE` | Explicit user authorization for a consequential external/sensitive/destructive effect. | final submit/send/contact, destructive reset/delete, sensitive account use outside an existing bounded grant |
| `BLOCK` | Refuse because the action violates a hard invariant or cannot be made safe. | self-approval, secret exfiltration, unknown external effect replay, unsupported destructive action |

Operation metadata provides facts for this decision; it does **not** mechanically decide the interaction outcome.

Relevant metadata includes:

- side effects and externality;
- reversibility / rollback support;
- destructive scope;
- sensitivity and identity/account use;
- whether Career Truth changes;
- idempotency and receipt evidence;
- previewability;
- existing user grant / prior decision;
- current Job / Resume / Application scope.

The active Agent or an independent reviewer may choose `AUTO`, `ASK` or `REVIEW` within the hard policy floor. Hard policy can always escalate to `AUTHORIZE` or `BLOCK`; the Agent cannot downgrade mandatory authorization.

## Hard invariants

Reducing interaction cost must **not** remove:

- no Agent self-approval;
- Fact Gate / provenance requirements for career claims;
- audit and receipts;
- stale/version checks;
- idempotency and duplicate-effect protection;
- secret isolation;
- unknown external-effect protection;
- destructive reset backup/restore guarantees;
- explicit authorization for final external submit/send/contact unless a separately implemented bounded grant explicitly covers the exact action.

These constraints belong in infrastructure and policy. They should not surface as repetitive user chores.

## Dialogue is never globally locked by task state

A Run may be paused, but normal conversation remains available.

Pending Proposal, pending Ask, interrupted Run, reconciliation or execution state must not disable the user from saying:

- “what does this mean?”;
- “change this first”;
- “keep the open-source experience but move it later”;
- “leave this for now”;
- “continue another task”;
- “cancel only that part”.

The Agent classifies new input as one of:

- answer;
- revise/steer;
- clarification;
- cancel;
- new task;
- unrelated conversation.

Technical state may constrain what can execute, but it does not silence the user.

## Navigation is not task lifecycle

Changing UI surface, opening a new conversation, loading history, closing the Agent panel or restarting the Desktop must not implicitly cancel a business Run.

`Conversation`, `UI navigation` and `Task/Run lifecycle` are separate concepts.

A waiting Run persists in the task/decision inbox until it is:

- completed;
- explicitly cancelled;
- superseded by a revision;
- terminally failed;
- automatically reconciled to a terminal state.

On restart, OfferU may say “2 tasks still need attention”; it must not automatically hijack the user's current conversation and require old work to be cleared first.

## User Inbox contains only actionable human work

Internal plan/task states are not user interaction states.

The product must distinguish at least:

- `none`;
- `needs_user_input`;
- `needs_user_review`;
- `needs_user_authorization`;
- `system_recovering`;
- `system_blocked`.

Only `needs_user_*` contributes to the visible pending-decision count.

`executing`, `paused`, `needs_reconciliation`, stale technical state or repair queues are system work unless a concrete semantic conflict genuinely requires a person.

Incomplete review packets must never be placed in the user Inbox. Missing Before/After, rationale, evidence, source identity or current version is an Agent/system repair problem.

## Before / After is system-generated

For a reviewable mutation:

- **Before** comes from current canonical state;
- **After** comes from the prepared proposed state;
- **Why** comes from Agent rationale;
- **Evidence** comes from source references;
- **Scope** identifies exactly what adoption changes.

The user is never asked to manufacture a diff in order to unlock approval.

## Revise is a first-class decision

`Revise` is not `Reject`.

A review surface supports:

- Approve;
- Revise;
- Reject.

Revision keeps the original task identity and records user feedback. The Agent rereads current canonical state and the user's feedback, creates a new revision, and only reopens the affected semantic decision. Unchanged, already-approved decisions are not asked again.

## Agent decides semantic grouping

Internal grouping can exist for:

- transactions;
- rollback;
- dependency ordering;
- audit;
- receipts.

Internal groups do not imply multiple user approvals.

If the user already chose a strategy such as “product-led positioning”, multiple derived edits may remain one semantic decision. The default interaction should be the smallest number of meaningful decisions, not the number of implementation groups.

For a normal single-job resume tailoring journey, target acceptance is:

- Ask only for unresolved material decisions;
- show one coherent reviewable version;
- allow natural-language revision;
- require at most one final adoption decision unless there are genuinely independent consequential choices.

## L0–L3 autonomy

The product-level default is:

- **L0 Observe** → `AUTO`;
- **L1 Prepare** → `AUTO` inside bounded scope;
- **L2 Reversible Career State change** → context-sensitive `AUTO` or `REVIEW` according to policy, grants and reversibility;
- **L3 External / sensitive / destructive** → `AUTHORIZE` unless a dedicated bounded-grant policy explicitly covers the exact action.

Do not mechanically equate all L2 actions with “ask the user”.

## Skill routing and composition

Normal users are not internal routers.

Automatic Skill selection may use:

- current user goal;
- recent conversation;
- canonical Career State;
- current Desktop entity/surface;
- curated Career Memory;
- live Skill/capability catalog.

If routing fails:

1. retry a bounded routing attempt when useful;
2. fall back to general/discovery reasoning or a safe generic capability;
3. ask a **business question** only when the user's intent is genuinely ambiguous.

Do not expose “choose Skill ID X/Y/Z” as a normal recovery path.

Third-party Skill **methodology** and third-party tool **side effects** are separate. A third-party Skill may contribute analysis, critique, research method or drafts without receiving permission to mutate Career Truth or perform external actions.

## Ask semantics

Structured Ask represents a real decision, not a generic checkbox list.

Ask schema should support:

- `selection_mode: single | multiple`;
- recommended option;
- optional skip;
- free-text policy;
- min/max selections.

Ask only when the answer materially changes a live decision and cannot already be read from authorized context. Ask answers provide preferences/context; they do not silently authorize unseen mutations.

## Dynamic actions, not fixed workflow buttons

Today and quick actions are derived from:

- Career Stage;
- target roles;
- current Job/Resume/Interview;
- Pipeline;
- recent outcomes;
- Memory;
- pending real decisions.

A known experienced-hire user must not see fixed campus/internship actions just because those strings were hard-coded into a UI component.

## Capability discovery is cached

Doctor/manifest/schema discovery is connection/runtime work, not a ritual to repeat on every career turn.

Cache verified capability identity by runtime/Skill/tool-contract version or digest. Rediscover when:

- runtime identity changes;
- Skill/tool contract changes;
- binding expires/stales;
- schema mismatch occurs;
- the current capability is missing.

## Acceptance metrics

Owner dogfood for one real Job should satisfy:

- chat input remains usable while tasks are pending;
- navigation never implicitly aborts a Run;
- restart does not force-open an old pending task;
- visible pending count equals genuinely actionable human decisions;
- invalid/incomplete review packets reaching user Inbox = 0;
- user-supplied Before/After = 0;
- manual Skill selection during a normal journey = 0;
- approval for ordinary research/draft/artifact persistence = 0;
- natural-language Revise works on the same task;
- final resume adoption decisions <= 1 unless independent high-impact choices exist;
- technical recovery requiring manual user intervention = 0 where the system has enough evidence to recover safely.

Passing unit tests is not sufficient evidence. The final acceptance must use a current build identity and a real owner journey.

## Current source hotspots

The 2026-10-06 review identified these files as important migration points:

- `backend/app/ops.py` — mutation-derived confirmation;
- `frontend/src/components/workbench/AgentPanel.tsx` — global input lock, navigation/run coupling, fixed quick actions;
- `frontend/src/components/workbench/AgentAskPanel.tsx` — selection semantics;
- `backend/app/services/agent_run_state.py` — waiting/interaction state projection;
- `backend/app/services/proposal_plan_store.py` — pending-plan semantics;
- `backend/app/services/agent_skill_registry.py` — router failure and plugin routing;
- `backend/app/services/career_director.py` and `career_policy.py` — mechanical L2/L3 user requirement;
- `.agents/skills/offeru/SKILL.md` and Resume method projections — semantic grouping and repeated capability ceremony.

This list is diagnostic, not a mandate to rewrite everything at once. Fix the P0 interaction deadlocks first, then simplify policy boundaries.

## External references

- Anthropic, *Building effective agents* / agent design guidance: https://www.anthropic.com/engineering/building-effective-agents
- OpenAI, agent safety / approvals guidance: https://developers.openai.com/api/docs/guides/agents/guardrails-approvals
- OpenAI, Auto-review research: https://alignment.openai.com/auto-review/
