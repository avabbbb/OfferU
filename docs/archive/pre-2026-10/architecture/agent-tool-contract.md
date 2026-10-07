> **已归档（2026-10）**：本文不再是当前权威。当前文档：08-module-agent-runtime.md（位于 `docs/`）。

# Host-neutral OfferU Tool Contract v1

Authority: GOAL → current-product → CONTEXT/current ADRs → Registry/live evidence. This contract reuses existing Operations, Skill Registry, AgentRun and CareerTask; it introduces no new database or scheduler.

## Executors and transports

External Agent is preferred reasoning/execution authority; the migrated built-in Python Agent remains a selectable provider and can use the same governed tools to prepare job-tailored resume changes. Exactly one reasoning provider owns a Run at a time. Local CLI/Bridge/MCP and officially supported remote connectors project the same business contract; authentication/transport implementations can differ. Unsupported host-native chat cannot be represented as embedded live chat.

## Discovery and invocation

1. Discover the compact Skill catalog (`manifest` for CLI); select a Skill and its minimal Operation allowlist. Full Registry enumeration is an audit view, not default remote authorization.
2. Discover each Operation schema, side effects and confirmation requirements. CLI `schema` and MCP schema discovery refer to the same Registry definition. Default MCP catalog is compact Skill discovery; `operation_catalog(skill=...)` expands a selected allowlist. UI-only Registry operations are excluded from MCP schema/invocation. This model-facing surface filter is not remote authorization or an entity grant.
3. Invoke `operation` + schema-validated `args` with existing dry-run and Run/Skill context. CLI uses one `run` per invocation; MCP uses `offeru_operation`; Bridge requires paired connection, Run attachment and lease. No raw DB, arbitrary HTTP or hidden shell business writes.
4. Consume existing `ok`, `outputs`, `errors` and proposal results. Surface real error/blocked status; never replace failure with invented data.
5. Protected effects call execute_or_propose_operation. Approval occurs independently in OfferU through the existing UI capability; no host receives a self-confirm tool. Resume proposals preserve source refs/rationale and semantic review.

## Context, persistence and permissions

Initial connection grants only the bootstrap/probe readback. Subsequent task context is minimum-sufficient canonical Job/Profile/Evidence/Resume/version/Interview/Today references, authorized for the user's request. Career Truth, curated Memory, observations/candidates, prospective task state and host conversation memory stay separate. Model-generated assumptions are not truth.

L0 observe, L1 bounded prepare, L2 protected Career State commit, L3 external action follow existing policy. Drafts/artifacts/results enter existing Job Workspace/Resume/Today/Inbox; adoption is distinct from preparation. Successful submit needs receipt evidence and dedupe; sending/submitting never follows from a chat claim.

Runtime owns AutomationEvent→AutomationRule→CareerTask scheduling, leases, idempotency, checkpoints/recovery and outcome persistence. Agent owns bounded reasoning and tool selection. External host scheduling must not create a second canonical automation loop; an explicit external wakeup resolves the existing task and policy before execution. Uncertain interrupted effects require reconciliation, not blind replay.

## Connection evidence and remote boundary

Detected binary → compatible capability probe → installed Skill → actual model-issued readback are distinct states. Host version/Skill hash changes invalidate stale checks. Replay, nonce extraction without tool use, fake model callbacks and browser actions do not prove Agent-native success. Provider failure remains visible even when local connection checks pass.

Readback checks persist in the existing AgentProviderHealth capability record, including host/version/Skill identity and successful Operation/turn references. Polling validates their short TTL and current installation identity; historical verification does not imply an authenticated account or healthy Provider today. The nonce itself is never persisted in the public health view.

Cloud connectors require host/account capability verification, authenticated scoped transport, expiry/revocation and audit. A secure tunnel is only transport, not permission. Do not expose port 8766, the unscoped MCP catalog or approval capability. This contract defines the boundary; remote connectors are not implemented by documenting it.

## Acceptance

Public Skills cannot instruct normal users to enter backend/, run source Python, manually fetch localhost projections or install directory matrices. Frozen projections and manifest must use the bundled executable/data directory from any working directory. Desktop connection installs only owned Skill files and preserves native login/model/proxy. Real Run/tool/artifact evidence and mounted UI outcomes are required; independent human confirmation cannot be satisfied by Agent or automated UI approval.
