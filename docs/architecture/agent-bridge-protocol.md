# Agent Bridge / Transport Contract

Status: **CURRENT IMPLEMENTATION BOUNDARY**  
Updated: 2026-09-23

OfferU may expose local machine-readable transports so external Agents can discover context and invoke governed Operations.

The transport is **not** the product architecture and does not require one universal protocol for every host.

## Stable semantic contract

Regardless of CLI/RPC/SDK/app-server transport, an integration must preserve:

- host/runtime identity and readiness metadata;
- one Agent Run identity for auditable execution;
- scoped Skill/tool discovery;
- typed Operation arguments/results;
- protected mutation → Proposal rather than self-confirmed write;
- idempotency metadata for side effects;
- explicit terminal success/failure;
- provider/transport failure separated from business outcome;
- no raw database or hidden business-write bypass.

## Current CLI surface

The CLI is a useful compatibility and automation surface, including manifest/operation discovery and atomic Operation execution. It is not required to be the user's product UI.

## Rich runtime adapters

Where a host exposes richer lifecycle APIs, an adapter may additionally support persistent session, streaming, steering, cancellation/resume and native tool events.

These capabilities must be capability-probed and evaluated per host.

## Confirmation

An Agent or third-party Skill may create/request a protected Proposal but cannot approve it on the user's behalf.

## Security

Credentials, raw secrets and unrestricted Career DB access must not be projected through Agent transports.

## Historical v1 stdio design

The previous DSH-oriented JSONL Bridge target is preserved at docs/archive/architecture/agent-bridge-protocol-v1-target-2026-09.md. Consult it only when maintaining that compatibility path; it is not the current product North Star.