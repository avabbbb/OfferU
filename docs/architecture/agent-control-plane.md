# Agent Control Plane

Status: **CURRENT ARCHITECTURE**  
Updated: 2026-09-23

The control plane connects an active reasoning Agent to deterministic Career OS capabilities.

It does not require a specific Harness, UI shell or provider.

## Responsibilities

- project the minimum authorized Career context;
- expose Skill-scoped Operations;
- validate Operation schema and permissions;
- execute safe reads;
- create persistent proposals for protected side effects;
- enforce idempotency and audit;
- record Agent Run/tool events needed for recovery and Eval;
- keep Career Truth in the Career Runtime.

## Non-responsibilities

The control plane does not:

- own the user's general Agent model or account;
- require OfferU to run inside a Harness UI;
- choose career truth from model prose;
- give a third-party Skill direct database access;
- treat shell/filesystem permission as business authorization;
- auto-confirm protected mutations.

## Logical flow

~~~
Active Agent
→ context / Skill discovery
→ Agent Tool Surface
→ Operation Registry
→ read result OR Proposal
→ user/policy review when required
→ Career Runtime
→ audit + event
~~~

## Runtime/transport adapters

Different hosts may use CLI, RPC, SDK, app-server, stdio or another local protocol. Those adapters are transport/lifecycle concerns.

They may normalize probe, start/resume, stream, interrupt/cancel and terminal results, but they must not duplicate career business logic.

## Human UI

OfferU Desktop is the primary product UI. Host-native extensions or companion windows may exist, but they consume the same canonical state and approval model.

## Evidence

Whether an adapter is READY is determined by live probes/tests, not this document.

Historical Harness-specific decomposition is preserved in docs/archive/architecture/agent-control-plane-harness-era-2026-09.md.