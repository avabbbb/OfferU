# Agent System

Status: **CURRENT ARCHITECTURE**  
Updated: 2026-09-23

## Summary

OfferU does not compete with local coding Agents on general reasoning. Its value is the Career OS state, tools, evidence, permissions and guided product experience that those Agents can safely use.

~~~
External local Agent (preferred)
        or
OfferU fallback Agent
        ↓
OfferU Skill + optional Career Skills
        ↓
Active Skill Surface
        ↓
Operation Registry
        ↓
Career Runtime
~~~

Exactly one Agent is the active reasoning authority for a Run.

## Host model

The canonical host metadata lives in code, not this document. Current host classes may include Skill host, hosted runtime/executor, both, detected-but-not-ready, blocked auth, incompatible and unavailable.

Never translate binary found into supported.

## External-first behavior

1. OfferU discovers available local Agents.
2. It probes readiness/auth without taking over credentials.
3. It recommends a ready host.
4. It installs/projects the OfferU Skill where supported.
5. The host uses its own model/account.
6. OfferU exposes only the relevant Skill/tool surface.
7. Agent work resolves against canonical Profile / Job / Application state and materializes into the same Job Workspace visible in OfferU Desktop.

A fallback OfferU Agent may be used if no external host is suitable.

The Skill is an **Agent entry surface**, not a second product database or project system. A power user may begin from a supported Agent, but the result must be the same governed OfferU state that the Desktop app reads.

## Skill composition

A host may activate OfferU plus third-party Career Skills. OfferU context should ground third-party methodology. Third-party output is draft/candidate material until accepted through OfferU's normal persistence path.

## Tools

Agents should not receive the entire Registry.

~~~
manifest
→ Skill catalog
→ manifest --skill <skill>
→ operation schema on demand
~~~

The tool surface must be evaluated with real Agent tasks. Do not optimize for a pretty tool count at the expense of task completion.

## Preparation plan and confirmation

Before broad preparation, paid model work or external side effects, the Agent should surface a compact user-facing plan when scope/cost/irreversibility makes that useful. The plan explains the intended work, evidence basis, proposal status and any known account/rate/cost boundary.

Protected state changes still create Proposals. The Agent may request a protected mutation and wait. It may not self-confirm it. OfferU UI is the authoritative human review surface.

Do not turn this into confirmation spam: work already inside an agreed safe scope can proceed until account, cost, scope or side-effect risk materially changes.

## Native tools

A host may keep native capabilities needed by the task, but OfferU business reads/writes must use OfferU capability boundaries. Native shell/filesystem/network tools do not grant permission to bypass Career Runtime or Registry controls.

## Eval

Evaluate task outcome, final persisted state, protected-record integrity, safety, truthfulness and provider/host failures. Tool trajectory is diagnostic rather than the sole proof of completion.

A model's prose is not proof that a business action happened.

See [Live Eval](../evals/LIVE_EVAL.md).