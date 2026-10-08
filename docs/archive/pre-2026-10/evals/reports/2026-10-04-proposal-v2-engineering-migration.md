> **已归档（2026-10）**：本文不再是当前权威。当前文档：历史证据，见 09-quality-and-release.md（位于 `docs/`）。

# Proposal v2 engineering migration evidence

Status: **IN_PROGRESS — NOT PRODUCT ACCEPTED**. Updated 2026-10-05.

## Baseline and organization

Original user checkout HEAD: `588d86082e99323da15fb5dd584916d3d938471a`. Dirty user code and the handoff were captured in local snapshot `fac78f6844de8b4b7ab80a81b335a94576c24355`; original checkout was not reset, stashed or replaced with origin/main. Implementation and validation run in `H:/tmp/offeru/proposal-v2-20261002/integration`.

Five independent implementation workers were requested as `gpt-6-luna`, reasoning effort `max`, in isolated worktrees. Host responses exposed task names/status, not an actual model identity attestation. Do not treat the names as model verification. Host thread capacity prevented five simultaneous workers; work proceeded with up to three children plus root. No grandchildren were created.

| Owner | Task / worktree | Main commits | Responsibility |
| --- | --- | --- | --- |
| A | luna1_persistence / luna-1 | c8f980a, b96de159, 13cd97e, c6a63f6, 206e462 | Six durable objects, versioned schema/backup migration, fenced storage, receipt history, leased outbox |
| B | luna3_execution / luna-3 | a7eff6b, 90c3dff | Exact Registry node authorization, group execution, idempotent effect vs attempt, failure/recovery |
| C | luna2_builder / luna-2 | 94f4c10, bf4bd91, 1fdd754, df86e59 | Plan entrypoints, native decision routes, CLI/MCP/Bridge restrictions, same-Run delivery and kernel fixture |
| D | luna4_desktop / luna-4 | 895d7a8, fb207565, 3d4bda3, bf9995b, 2e0fcd7, 5891fc2, 78aaa8e | Plan Review/native group approval, AgentPanel routing, entity labels and terminal-group folding |
| E | luna5_acceptance / luna-5 | 02b09e8, 00ba4bc, 6be78f6, 3726748, b9d4889, 16aa417, 5469207 | Independent concurrency, faults, retries, batch adoption, restore and receipt-set tests |

Root owns shared DTO/digests/source witnesses, Run projection/CAS, generated types/Skills, contract, diff review and integration. Worker completion messages were not accepted as integrated PASS.

## Implemented path

The active Agent can prepare exact Registry intents with explicit semantic groups. Preparation captures canonical source versions and real resume Before/After, evidence and rationale; protected nodes do not execute at this stage. Independent Desktop authorization binds the fixed plan/group digests. Coordinator claims a persisted node, and the existing Registry validates the exact normalized arguments, schema/version, scope, decision, lease and audited source prefix. Existing business functions and OperationAuditLog remain authoritative.

AgentRun steps are a read projection for new plans. Legacy step proposal/rejection writers were retired; legacy actions require an exact singleton mapping and displayed digests, or fail visibly with a request to use Plan Review. Old execution evidence is retained. Unknown effects and interrupted claims do not replay automatically. One failed group pauses its remaining nodes. Proven no-effect transient retries preserve the business identity and failed audit, using separate fenced attempt identities.

Receipts and outbox are durable. Delivery is receipt-set-scoped and fenced. Accepted receipts remain in the original Run/session; failed reasoning startup does not undo committed effects. External hosts lacking proactive continuation retain receipts for the original host to read. UI-only requests persist results without creating a reasoner. Lease renewal and receipt-set acknowledgment are separate from human authorization.

## Executed checks and practical limits

| Check | Observed result | Scope / limits |
| --- | --- | --- |
| Selected pre-migration baseline backend checks | 68 passed | Migration/auth/kernel/architecture selection, not complete baseline suite |
| Shared Builder | 9 passed | 18 Registry resume intents in 3 supplied semantic groups; static tamper/graph checks |
| Schema + Builder | 15 passed | Includes version 5/6 migration and replay checks |
| Combined new core checks | 46 passed | Before the later extension cases; does not establish real model or human acceptance |
| Independent true Registry fixture | 18 intents in 4 groups; 5 actual writes in one group with one synthetic decision and per-node audit passed | Explicit synthetic approval; not a human decision or Agent-native trace |
| Extended faults + Store | 26 passed, 1 failed | Failure was nondeterministic receipt ordering on coarse creation timestamps; ordered by completion and targeted case passed afterward; combined rerun pending |
| No-effect retry / counterfeit source prefixes | 4 passed | Failed audit preserved; actual receipt/audit tampering denied; after Store string error fix |
| Outbox receipt-set growth / stale consumer | 1 passed | Real stored receipt fixtures; does not claim new business execution for synthetic additional receipts |
| Architecture + selected authorization | 55 passed | AST audit updated to recognize the governed Coordinator path; route/core authorization behavior checked independently |
| Frontend selected regression + typecheck | 22 passed; typecheck passed | Final Plan Review, AgentPanel routing and native decision client selection; earlier broader 23-case selection also passed before the folding patch |
| Frontend production build | passed | Static assets; not a freshly packaged Python sidecar or installer |
| Rust native approval checks | 3 passed | Validated IDs/digests/path boundaries; existing ignored resources used for compilation, not new installer evidence |
| Broader compatibility selection | 36 passed, 12 failed, stopped at maxfail | Included missing host import (fixed) and old step-confirmation/fixture assumptions; meaningful new-chain fixture migration pending |
| Release/data safety/resume/Skill/CLI selection | 135 passed, 4 failed, 5 skipped, 6 subtests passed | Architecture failure later fixed; three legacy CLI expectation cases pending migration |
| Latest combined new backend selection | 61 passed, 1 failed | Kernel fake-capability isolation fails after another test reloads the module; owner fixing aliases, production authorization stays enforced |
| Latest source display/guard selection | 3 passed | Before/After only shows changed fields; undisplayed canonical source edits still invalidate authorization |
| Kernel module independently | 9 passed | Includes actual Registry batch adoption and same Run/session continuation through a scripted provider; not live model evidence |
| Mounted Plan Review desktop/mobile | passed | Managed Chromium headless, 4 fixture groups / 3 pending controls, terminal groups folded, readable entities, zero automated decision requests |
| Non-resume synchronous domain effects + source guard | 5 passed | Real Registry Job triage and Profile headline/target-role adoption, exact source progression and per-node Audit; bulk DML cannot manufacture no-effect proof |
| Configured live model Plan preparation | passed | DeepSeek / devin/deepseek-v4-1-flash; synthetic Career Truth, actual model-issued tools and persisted pending Plan; no protected execution or human approval |
| Final control-plane / compatibility / persistence selection | 110 passed, 5 skipped | Builder/Store/authorization/continuation, native decision routes, Bridge, bound CLI, startup, schema migration and data safety; optional environment cases skipped |
| Final boundary selection | 50 passed | Source guards, non-resume domain effects, Host, kernel and independent faults including three restore cycles; no real user-data writes |
| Bound CLI module | 48 passed | Existing external Run binding, synthetic independent UI decision, real Job/Audit readback, duplicate receipt identity and no CLI self-approval |
| Host module | 13 passed | Updated fake kernel contract, real batch resume adoption, original Run continuation, immutable legacy history and reconciliation diagnostics |
| Fresh Windows sidecar build / packaged CLI schema | passed | New 279 MB backend built from integration source, bundled Node/runtime and managed browser; packaged executable returned the real Plan preparation schema in isolated H data; not installer/upgrade/native approval acceptance |
| Whole 18-node / 4-group execution | passed after immutable refresh integration | Four persisted synthetic UI decisions, 18 real Registry writes/audits/committed receipts; exact original intents preserved, only never-authorized remainder re-snapshotted |
| Store + refresh faults + execution/restore acceptance | 44 passed | Includes foreign edits denied, original leases/history preserved, old snapshots refused, actual CAS race and complete multi-group task |
| Workspace proof and Registry integration | 10 passed | Canonical creation/reuse readback, no forged row/result acceptance, same Run creation then batch adoption, node audit identity; synthetic gate fixture, not live Desktop |
| Current successor review UI | 24 passed; typecheck passed | Delayed older polls cannot restore old approval content, retired plans cannot be decided, second click binds the displayed successor snapshot |
| Refreshed review frontend | 23 passed; typecheck passed | Separate second click sends newly displayed successor digests; predecessor history is retained; storage integration is still pending |
| Packaged startup + database integrity | passed | Isolated H data, API health ready, schema 6, integrity ok and zero FK violations; verified owned smoke server stopped and 8766 freed; built before the refresh follow-up |

The original source checkout has not yet been switched. The whole release gate, full callsite convergence and complete regression result remain unproven.

## Pending evidence

- Integrated rerun of kernel turn → Plan → synthetic independent UI decision → Registry receipt → original session continuation, after the cross-suite fixture fix.
- The directly named old host/kernel/approval/Bridge/CLI fixtures now use the new authority or assert explicit refusal of legacy action-only decisions. Broader release and full-suite convergence remain pending.
- Continue effect adapters beyond the proven synchronous resume, Job update/batch and default Profile/target-role operations. Bulk-DML memory review, asynchronous research, filesystem and external effects require dedicated evidence; full callsite convergence remains unproven.
- Re-run the extended cases and all directly required compatibility, persistence/security and release gates on the final integrated commit.
- Real configured model-issued tools and real Job/Profile dogfood; human Desktop group approval remains an independent manual boundary.
- Fresh installer upgrade/native startup and restart evidence. Sidecar build and packaged schema startup passed; neither constitutes installer acceptance.
- Apply only reviewed migration differences to the original dirty checkout after final integration gates; preserve subsequent user edits.

## Execution interruptions

Several Luna turns terminated with host usage-limit errors; no alternative model was silently selected. H drive filled during isolated compilation, truncating an integration Run state file and an uncommitted Store source. The committed integration file was restored from Git and A recovered/committed the Store. Original user files and real Career Truth were not used for migration tests. Disk space was subsequently revalidated; an attempted cache deletion was automatically rejected and was not executed.

Browser checks used managed Chromium headless at fixed `127.0.0.1:7410`, isolated H-drive artifacts and fixture APIs. Screenshots and assertions verify Plan Review at desktop/mobile widths; no approval was automated. Fixtures disable onboarding only in isolated browser storage. These are UI checks, not real model, real Profile/Job, Desktop native approval or installer evidence.

The user selected the current Job Workspace and existing Profile for eventual Desktop dogfood. A configured-provider smoke passed against synthetic Career Truth, preserving native provider/model messages, tool calls, events and a sealed pending Plan under `live-model-plan/evidence.json` in the isolated task directory. The model read Profile/Job/Resume and preparation tools; its first wrong Run ID was rejected, it repaired the request, and the same Run reached `waiting_confirmation`. All protected nodes remained pending. This is live-model Plan evidence only, not a real user-data task or approval/continuation acceptance.

The full frontend selection yielded 91 passed / 1 failed. The failing Today fixture requests the practice button without supplying practice metadata; the page, test and DeliveryList match the preserved user snapshot exactly. It remains a failing check, not a migration PASS. Required targeted frontend checks and mounted review are green.

Several latest C/B/E follow-ups hit the host quota. Root reviewed and integrated the already-written C/E changes, corrected unclosed SQLite fixture handles on Windows, and fixed two genuine singleton adapter defects: an undeclared Group input field and a completed UI request retaining waiting-confirmation status. No production capability check was weakened. Source-less legacy nodes now fail before any business write and require a newly displayed snapshot.

A stronger whole-plan test initially failed at the second group because authorized changes correctly invalidated the old source snapshot. The integrated immutable remainder refresh now passes that test: four distinct stored synthetic UI decisions execute all eighteen original Registry intents. This is complete synthetic multi-group execution evidence, not real-model/human product acceptance.

The optional question had no reply after the response window; implementation used the stated recommendation of automatic re-snapshotting of never-authorized groups. A's strengthened source-chain Store validation and E's independent cases are integrated and tested. Root completed B's saved workspace proof after a quota interruption, fixed the snapshot helper import and no-change reuse classification, and wired it into execution. Existing `ensure_resume_workspace` is L1 preparation in the preserved baseline: unplanned preparation still executes without extra approval; when explicitly placed inside a Plan its Registry audit now binds the exact node claim. Broader release gates, final source checkout application, live real-user-data Desktop review and installer evidence remain incomplete.

See [migration handoff](../../architecture/proposal-v2-migration-handoff.md) and [frozen implementation contract](../../architecture/proposal-v2-implementation-contract.md). This report is evidence accounting, not a declaration that Proposal v2 is complete.
