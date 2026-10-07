> **已归档（2026-10）**：本文不再是当前权威。当前文档：08-module-agent-runtime.md（位于 `docs/`）。

# Proposal v2 implementation contract

Implementation coordination only, 2026-10-02. Follow GOAL/current-product and [handoff](./proposal-v2-migration-handoff.md). This freezes shared interfaces, not a second design proposal.

## Ownership

A / luna-1: models/models.py, database.py migrations, services/proposal_plan_store.py and store/migration tests. All six objects belong to this owner; no independent object-specific planners.
B / luna-3: agent_run_coordinator.py, services/proposal_plan_execution.py, ops.py authorization/audit/idempotency seams ONLY and execution tests. Registry catalog modifications belong to root.
C / luna-2 (reassigned before any code was written): proposal_hook, embedded host/worker, operation_projection, agent routes, Bridge/CLI/MCP adapters, services/proposal_plan_continuation.py and integration tests. Startup recovery wiring requested from root.
D / luna-4: frontend API and PlanReview/PendingProposalReview/AgentPanel components, native Tauri approval command, dedicated tests. api-types.generated.ts belongs to root.
E / luna-5: dedicated behavioral fault/upgrade/concurrency/compatibility tests and fault fixtures; no production-file changes. Run no full suites/builds during implementation; root runs verification against integrated baseline.
Root: common DTO/state/digest contract, proposal_plan_builder.py, agent_run_state.py, startup_recovery.py, generated types, Registry staging catalog/skill allowlist seams, shared documentation and integration. Cross-owner edits only through root.

Each worker uses its own worktree. No grandchildren. Cross-owner requirements go to root. No resets/rebases to origin/main. Keep user baseline changes. Existing Registry, Career Truth, audit, grants, fact gates, masking and independent UI approval remain authoritative.

## Shared payload (JSON)

Plan: id, run_id, revision, status, digest, title, groups[].
Group: id, plan_id, title, rationale, summary, affected_entities[], risk, dependency_group_ids[], digest, status, nodes[].
Node: id, group_id, operation, args, summary, dependency_node_ids[], status, idempotency_key, result/receipt references.
Decision: id/event_id, plan_id, group_id, plan_digest, group_digest, decision (approve/reject), trusted authorization source reference. No Agent-facing boolean grants human authority.
Receipt: id, node_id, status, effect_state (no_effect/committed/partial/unknown), result, audit reference, timestamps. Continuation binds run_id, group_id and receipt ids and is durable/deduped.

Use plain dict DTOs at service boundaries; ORM models remain store-owned. IDs and digest fields must be fixed before approval. Existing frontend run IDs retain validation.

## Service seams

Builder: `build_plan(intents, *, run_id, title, groups=None)` -> validated immutable plan dict. Semantic groups are supplied by the active reasoning authority or explicit intent metadata, never a keyword-based career decision script. Validate operation schemas with OPERATIONS, preserve protected risk boundaries, validate dependency DAGs, generate digests with one canonical digest helper. Explicit group metadata may be used for deterministic tests.

Store (root-frozen, dict DTOs): `create_plan(plan)`; `get_plan(plan_id)`; `list_plans(run_id=None,pending_only=False)`; `replace_plan(plan_id,replacement)`; `record_decision(decision)` exact replay yields duplicate=true and changed identity fails; `get_node_authorization(node_id)` returns {plan,group,node,decision}; `claim_node(node_id, *, claim_id,lease_seconds=60)` returns node or None; `checkpoint_node(node_id, *,claim_id,status,effect_state,result=None,audit_ref=None,error=None,receipt_id=None)` verifies fencing and atomically stores receipt/pauses group; `pause_group(group_id, *,status,reason)`; `recover_executing_nodes(run_id=None)` records unknown and reconciliation without replay; `resolve_node_reconciliation(node_id, *,effect_state,evidence)` only uses independently validated evidence; `create_continuation(continuation)` returns duplicate flag; `list_continuations(run_id=None)`; `claim_continuation(id, *,claim_id,lease_seconds=60)`; `finish_continuation(id, *,claim_id,status,error=None)`. Claim/decisions include parent-group/node dependency validation, serialized SQLite write reservation and/or actual CAS/unique constraints. No FOR UPDATE-only protection.

Snapshot version: offeru.proposal-plan.v2. UUID hex IDs with plan_/group_/node_/decision_/receipt_/continuation_ prefixes (lowercase hex, 32 digits). Externally supplied intent/group IDs are labels, mapped into fixed IDs before sealing. Plan revision starts at 1, replacement uses same run and lineage_id with new plan ID and parent_plan_id. Preserve completed history; replacement only before any node execution or approval effects.

States frozen: plan sealed/executing/paused/completed/rejected/blocked/needs_reconciliation/replaced; group pending/approved/executing/paused/completed/rejected/blocked/needs_reconciliation/stale; node pending/executing/completed/failed/rejected/blocked/uncertain; continuation pending/delivering/delivered/failed. Failed continuation is retryable under valid lease and must not change committed group outcomes. Ordinary execution exceptions are unknown effects unless a trusted executor evidence field proves otherwise.

Cross-group refresh adds `group.replaced` as history only. After proven completed groups change canonical sources, `refresh_unexecuted_groups(plan_id)` may produce a new immutable Plan revision containing only pending, never-authorized, never-claimed nodes. Same Run/lineage and `parent_plan_id` preserve the original reasoning subject. A digest-bound `refresh_from={plan_id,group_ids,completed_receipt_ids}` carries provenance; it grants no approval. Exact operation/schema/args/rationale/scope/DAG intent is preserved; canonical Before/After and versions are reread. Foreign edits, partial/unknown effects, changed Registry contracts and active claims forbid automatic refresh.

Store seam `replace_unexecuted_groups(plan_id,replacement,*,group_ids,completed_receipt_ids,expected_sources)` serializes validation and insertion with SQLite `_write`: selected groups have no decision/lease/receipt/attempt, committed receipts match canonical audits and source chains, and current canonical source hashes still match. Only these old pending groups become replaced (nodes blocked); completed nodes, decisions, receipts and effect identities never change. One lineage revision wins concurrent refresh/approval. Group decision responses expose `successor_plan_id`; Desktop displays its current revision before a separate user click submits its new digests. Never execute using the old click or old approval after re-snapshotting.

Digests bind version, identities/revision/lineage, run_id, exact operation name/version/input_schema fingerprint, normalized args, targets/affected entities, source/workspace versions, displayed change/diff/evidence/rationale, dependencies and authoritative risk/scope. Runtime status/result/claim/lease/receipt fields are excluded. Canonical helper rejects non-JSON values, NaN and Infinity. Builder generates node/group/plan digest from explicit material; shared `verify_plan_snapshot` revalidates all three against current schema. Actual node args must equal the sealed normalized args at Registry execution; existing domain fact/stale gates remain active.

Business effect identity (node id + sealed input digest) differs from attempt identity (claim/fencing/attempt ordinal). No deletion of audit and no new business key merely to retry. Proven no_effect and transient evidence is required to rearm an attempt under unchanged approval; root/B must make audit transition explicit. Lease expiry is not no_effect. Claim loss invalidates completion publishing. Commit-before-receipt crash checks existing audit and domain evidence; unknown never replays automatically.

Execution rejects missing canonical source references before entering the Registry. Existing mapped business rows outside the reviewed source set cannot flush a mutation. The current ORM witness proves only inspected synchronous resume, Job update/batch and simple default Profile/target-role paths. Bulk business DML cannot establish no_effect through this observer. Profile archive replacement is refused during preparation until a complete derived-change preview/effect adapter exists. Other effects require dedicated adapters; an audited `ok` response alone does not establish complete commitment.

Continuation outbox is created transactionally with terminal group receipt checkpoint or recovered idempotently from durable completed receipts; root/C must close both windows. Consumption is leased; mark delivered only after original Run accepted the continuation/session checkpoint. Delivery may duplicate but receipt IDs are deduped at original Run before model launch/re-entry. External host unsupported push: retain pending receipts for same host/session readback, never launch a new hosted reasoner.

Legacy migration: pending -> exact singleton new pending group with original inputs; no invented decision. executing/uncertain -> preserved history + needs_reconciliation, never replay. completed -> historical evidence only, no new pending node/effect. failed -> preserve evidence, no retry absent proven no_effect. rejected -> historical rejected, no pending execution. If raw inputs/digest equivalence cannot be proven, keep history and require new display. Old action_id never authorizes extra nodes. End state: no old step-backed execution authority; compatibility adapters read/map exact legacy scope or visibly refuse it.

Execution: `confirm_group(plan_id, group_id, *, plan_digest, group_digest, decision_id, authorization_source, surface)` and `reject_group(...)` -> {ok, plan, group, receipts, errors, duplicate}. authorization_source is the existing UI capability bearer header validated by core as well as routes; persist only a nonsecret reference such as desktop-ui, never the bearer. Arbitrary strings/booleans do not grant authority. Tests patch the existing fake capability; no real keyring or human acceptance claim. Agent code cannot call these as tools. Every node uses confirmed_operation + execute_operation and existing audit. Coordinator exposes group dispatch as a method delegating to this control plane, not a new business executor.

Integration/API: existing local Runtime read transport/grants apply to `GET /api/agent/plans` (optional run_id), `GET /api/agent/plans/{plan_id}`; no approval bearer in JavaScript. Native UI-approved write `POST /api/agent/plans/{plan_id}/groups/{group_id}/decision` with {approve, plan_digest, group_digest, decision_id}. Reuse existing independent UI approval capability validation in routes and core. No plain web/Agent token can approve. Plan detail may add continuations[]; decision may add continuation/run_status. Integration owner publishes route/schema changes to UI owner.

Shared recovery seam: store `migrate_legacy_proposals(run_id=None)` -> {imported,preserved,needs_review,reconciliation}; startup calls it then recover_executing_nodes without executing any business node. Run `sync_proposal_plan_state(run_id, *,event_type='proposal.plan_ready',payload=None)` persists visible status/events, and load_agent_run derives steps from new objects. C `deliver_continuations(run_id, *,resume_agent=None)` -> {delivered,failed,pending,continuations,run}; callback must accept original Run and receipts, commit a deduped original-session receipt checkpoint before delivered. Snapshot/store originals never expose approval bearer.

Model-facing plan preparation is an allowlisted L1 intent staging capability, not approval; keep Registry discoverability and validation. Nodes are not executed during preparation. Resume diff adoption reuses existing batch review Operation where possible. Legacy single-operation adapters map to exact singleton group; legacy records remain fail-safe and historical data stays preserved.

## Failure semantics

First failure pauses remaining group nodes. Proven no_effect transient error may be retried within valid unchanged authorization with a bounded policy. Unknown/partial effects require reconciliation before replay. Permanent/fact gate/stale errors do not auto-retry. Changed inputs/content/scope require new review. Group state gates every claim and compatibility entry. No forced 3–7 grouping count and no cross-Operation atomicity claim.

## Acceptance

15–20 validated resume-related intents in 3–7 supplied semantic groups; one group >=5 actual Registry nodes yields one independent decision and per-node audits. Duplicate/concurrent decisions, reject dependencies, stale/tampered digests, crash/reconciliation, continuation same Run, compatibility and mounted UI. Fixtures are not real Agent-native or human acceptance. Tests/temp/profile/logs only H:/tmp/offeru. No real DB/keyring writes in automated checks.
