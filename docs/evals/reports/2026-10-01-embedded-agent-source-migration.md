# Embedded Agent source migration

Date: 2026-10-01. Status: source replacement and UI adaptation implemented;
targeted regression and isolated live model read passed. This is not a Public
Release readiness declaration or a human approval acceptance result.

## Source and migration boundary

- Upstream: https://github.com/luyishui/OfferU
- Pinned commit: `3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5` (2026-09-28).
- The actual `types`, `messages`, `hooks`, `loop`, `compaction` and
  `branch_summary` source files are byte-identical to upstream. `provider` and
  `proposal_hook` were copied and adapted. MIT LICENSE and attribution are
  preserved in `backend/app/agent/` and `THIRD_PARTY_NOTICES.md`.
- Upstream tool reducer cases and `ToolExecutionList` were transplanted into
  `frontend/src/lib/embeddedAgentStream.ts` and
  `frontend/src/components/workbench/EmbeddedAgentStreamView.tsx`; event and
  theme adapters connect the current Workbench.
- Upstream SQL orchestrator, operator CRUD authority, actor/session tables and
  session-tree UI are not imported wholesale. Existing AgentRun/CareerTask,
  conversation history, Registry, proposals and audit remain their authority.
  Branch navigation is not exposed in this migration. `branch_summary.py` is
  preserved upstream code, not a claim of a working branch-navigation feature.

## Changes and acceptance mapping

| Area / files | Result / acceptance |
| --- | --- |
| `backend/app/agent/`, `services/embedded_agent_worker.py` | Actual upstream bounded tool loop; canonical LLM config/client and vault; OpenAI-compatible and native Anthropic stream adaptation; remote PII masking and local restoration; versioned atomic JSON sessions; cancellation, steering, follow-up and compaction adapters. |
| `services/embedded_agent_host.py`, `agent_runtime.py`, routes/main_agent.py, main.py | One production embedded Python kernel; Skill allowlists and all business tools retain Registry governance; existing Pi kernel files and Node worker removed. Legacy request schema class names remain for API compatibility. |
| `embedded_agent_host.py`, `agent_run_state.py` | Protected mutations remain pending until independently authorized. Last approved action can continue the same Run using committed receipts. Duplicate approval cannot repeat its mutation; model startup failure remains separate from successful action execution. Legacy Pi sessions are preserved and cannot silently replay. |
| `career_tasks.py`, `automation.py`, `agent_run_state.py`, `ops.py` | Scheduled task routing uses embedded Python; Run task containers link to the existing CareerTask identity and canonical target. A delayed task-start notification cannot overwrite a terminal Inbox result. No second scheduler or business-state authority introduced. |
| `AgentPanel.tsx`, `api.ts`, migrated stream/view files | Live tool status; exact proposal arguments; continuation progress and explanation, including new pending proposals; persisted tool history reload; new conversation clears prior tool state. |
| `frontend/src-tauri/src/lib.rs` | Runtime approval accepts validated `run_<hex>` IDs; Bridge proposal UUID validation remains separate. Native confirmation timeout allows bounded model continuation. Browser-only confirmation still fails closed. |
| `agent-runtime/package*.json`, README, build_sidecar.mjs / .ps1 | Pi SDK dependencies removed. Node staging retains the optional external Claude hosted executor; the embedded Python code is collected with the backend. |
| Architecture / notices | Current kernel and source provenance documented. External coding-Agent hosts, including external Pi, retain their existing roles. |

No schema-version migration, old-session conversion, production DB reset or
credential-store mutation was performed. Pre-existing workspace changes were
preserved. Tests use isolated data under `H:/tmp/offeru`.

## Executed checks

| Check | Result |
| --- | --- |
| Combined backend regression: career evolution/policy/delivery/snapshot, LLM protocols/vault, DB migrations, runtime convergence, migrated kernel/host, approval auth, provider health, startup recovery | **135 passed**. |
| Migrated kernel after adding legacy-session preservation and tool labels | **10 passed**; overlaps the combined suite, not an additional 10 to sum. Includes protected mutation/continuation, duplicate confirmation, continuation configuration failure, cancellation, tool allowlist, stream failure/redaction and native Anthropic fragment tests. |
| Frontend migrated reducer/view, PendingProposalReview and native decision tests | **4 files / 8 tests passed**. |
| Frontend typecheck and production build after final UI edits | **Passed**. Existing Browserslist age/plugin timing notices remain. |
| Rust native approval validation: `cargo test --lib approval_tests --offline` | **1 passed**; accepts runtime IDs and rejects path injection/invalid IDs. |
| Node worker/build-script syntax; PowerShell builder parsing; git diff whitespace | **Passed**. |
| Architecture audit tests | **51 passed, 1 failed**: unchanged `backend/app/routes/optimize.py::optimize_agent_chat_stream` bypasses Registry. This is still a release gate failure. |
| Broader runtime-path check | **1 remaining failure**: unchanged `test_packaged_resume_resources_do_not_follow_writable_data` expects its synthetic bundle browser path to override an incompatible environment path. `sidecar_entry.py` and this test were not changed. |

Initial collection/cwd and outdated fixture-protocol errors were corrected and
rerun; they are not counted as passing checks. No full backend suite or installer
build was claimed.

## Real model evidence

The configured `deepseek` provider / `devin/deepseek-v4-1-flash` model ran through
the migrated production kernel against an independent empty SQLite DB.

- Run: `run_2c4faa8116984eb3`, status `completed`.
- Model-issued Registry operation: `list_jobs`.
- Tool result: total 0, empty items; the assistant accurately reported that read.
- Pending mutations: 0. No user career data was used.
- The Run, model messages and operation events are persisted in the isolated
  runtime. This is a real model read smoke, not a protected-write or human HITL
  E2E.
- The first attempt used the `discovery` Skill, which only exposes `get_profile`.
  The model correctly refused to invent a `list_jobs` call. The successful run
  uses the authorized `evaluate_job` Skill.

Evidence: `H:/tmp/offeru/agent-migration-review/live-model/result.json` and the
isolated DB/session files. Existing vault configuration was read in memory;
keys were not copied into fixtures or logs.

## Mounted UI evidence

Managed Chromium, headless, isolated temporary profile. Page origin is
`http://127.0.0.1:7410`; every business API is intercepted. The current production
build is served inside the browser's isolated request routes because the user's
existing Vite service returned `504 Outdated Optimize Dep`. That service was
neither stopped nor modified.

**9 checks passed**, no page runtime errors: actual AgentPanel mounted, tool
success/failure, raw-result canary absent, proposal scope, browser cannot confirm,
mocked native decision result, next-proposal explanation, continuation readback
tools and new-conversation cleanup. The native decision return was a fixture;
no real approval capability or business write was used.

Artifacts under `H:/tmp/offeru/agent-migration-review/`:

- `source-manifest.json`: upstream/local SHA-256 comparison.
- `ui-smoke.cjs`, `ui-smoke.json`: isolated UI fixture and check record.
- `ui-migrated-agent.png`, `ui-continuation-fixture.png`: mounted UI captures.
- `live-kernel-smoke.py`, `live-model/result.json`: actual model read smoke.

## Remaining acceptance boundaries

- A human must independently approve and inspect a real protected operation in
  the Desktop app before calling the full approval workflow human-accepted.
- Native approval timeout/network behavior and installed-app upgrade require
  packaged Desktop acceptance; Rust validation and simulated UI do not prove
  those layers.
- Full installer/sidecar packaging, full backend regression and the two existing
  failing release checks above remain outstanding.
- Legacy Pi history is retained, with explicit refusal to resume through the
  new kernel; users must open a new task for new reasoning.
