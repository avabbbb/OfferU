# Tool Surface V2 — Operation Registry is not the Agent Tool Catalog

Date: 2026-09-22  
Status: **CURRENT / merged in #17**

## Problem

OfferU deliberately routes every governed capability through the Operation Registry, so the
registry contains more than model-facing tools:

- Career-domain primitives;
- product workflows;
- UI route mutations;
- compatibility/legacy routes;
- diagnostics and data-safety operations;
- integration lifecycle operations;
- Agent helpers.

That control-plane breadth is useful for audit and authorization, but it is harmful if every
entry is presented as an equally eligible Agent tool.

Pre-change baseline on the assisted-apply branch (historical counts used for the V2 comparison):

| Surface | Count |
| --- | ---: |
| Governed Operation Registry | 263 |
| Operations referenced by any built-in Agent Skill | 112 |
| Operations referenced by featured Skills | 76 |
| Registry Operations not referenced by a built-in Skill | 151 |

Therefore **263 registered Operations did not mean that an Agent was supposed to choose among
263 tools at once**. The real defect was that some discovery paths, especially group discovery,
could still expose UI CRUD, migration, diagnostic, and legacy entries as peers of Agent-oriented
tools.

## Design rule

OfferU now treats these as three different surfaces:

```text
Operation Registry
  └─ all governed execution capabilities
     └─ Agent Tool Surface
        └─ union of live Skill allowlists
           └─ Active Skill Surface
              └─ only the selected Skill's Operations
```

### 1. Operation Registry

Purpose: execution authority, validation, Proposal/HITL, audit, route reuse.

It may remain broad.

Use the explicit developer escape hatch:

```text
python -m app.cli manifest --all --pretty
python -m app.cli ops --all --pretty
```

This is **not** the default model-facing catalog.

### 2. Agent Tool Surface

Purpose: the Operations intentionally designed for an external Agent.

Source of truth: union of Skill `allowed_tools`.

Use:

```text
python -m app.cli ops --group <group> --pretty
```

Group discovery now intersects the Registry group with the Agent Tool Surface.

### 3. Active Skill Surface

Purpose: the smallest task-specific tool set.

Use:

```text
python -m app.cli manifest --skill <skill-id> --pretty
```

The generated OfferU Skill already instructs Coding Agents to choose one Skill first and inspect
schemas only as needed. This remains the canonical path.

## Concrete impact of Agent-filtered group discovery

Before this slice, group discovery could expose the raw Registry group.

Examples from the assisted-apply branch:

| Group | Registry Operations | Built-in Skill Operations |
| --- | ---: | ---: |
| resume | 42 | 8 |
| applications | 40 | 17 |
| agent_runtime | 31 | 14 |
| profile | 26 | 3 |
| memory | 20 | 14 |
| research | 19 | 17 |
| interview | 18 | 14 |
| jobs | 16 | 5 |

The purpose is not to force every group below an arbitrary count. It is to stop route-level CRUD
and maintenance commands from competing with task-oriented Agent tools.

## Evidence-backed registry cleanup in this slice

The registry itself is reduced from **263 to 260** by three narrow changes with direct evidence.

### Remove: `get_agent_provider_health`

Why:

- no product route or built-in Skill used the single-provider Operation;
- the real UI/Agent path uses `list_agent_provider_health`;
- keeping both creates an unnecessary selection ambiguity.

The lower-level provider-health service remains available to implementation code.

### Remove: `get_synthetic_email_test_data_status`

Why:

- it existed as a Registry entry without a product route or Skill;
- its service function is still useful to privacy-hygiene tests;
- synthetic-fixture inspection is test infrastructure, not an Agent capability.

The service function is not deleted.

### Merge: `generate_legacy_cover_letter` → `generate_cover_letter`

Why:

- both Operations accepted the same business identity: `job_id + resume_id`;
- both generated a cover-letter draft;
- the canonical implementation reads the current structured Resume/ResumeSection model;
- the legacy `/applications/generate` route can use the canonical Operation without changing the
  external HTTP request shape.

This removes a duplicated model-facing/business capability rather than merely hiding it.

## Why the other legacy Operations are not deleted here

The old inventory labels 28 implementations as legacy, but many still serve current HTTP/UI
compatibility surfaces.

Examples:

- application-table CRUD still backs the existing Application Workspace;
- resume template/section/share/photo CRUD still backs Resume UI routes;
- `create_legacy_application` and `create_application` are **not equivalent**:
  one writes the old `Application` model, the other writes the current
  `ApplicationRecord` workspace model;
- `get_legacy_profile` still backs current profile routes and returns a different payload.

Deleting or aliasing those without migrating their state models would reduce apparent tool count
by creating data inconsistency. Tool Surface V2 therefore hides them from Agent discovery first
and leaves route/data migration to a separate change.

## Deferred consolidation candidates

These are candidates, not deletions in this PR.

### A. Application progress internals

Candidate:
- `classify_progress_signal`

Reason:
- appears to be a retry/internal classification primitive rather than a normal user goal;
- no literal route/Skill caller was found in the current static search.

Gate before removal:
- runtime/audit trace proving no dynamic caller;
- application-progress regression suite.

### B. Projection and memory internals

Candidates:
- `build_job_projection`
- `distill_memory`
- `promote_session_memory`

These may be orchestration internals. Do not remove until their dynamic task/automation callers are
traced.

### C. Skill-level consolidation

Current larger Skill allowlists include:

- `follow_up`: 22 Operations;
- `company_research`: 18;
- `tailor_resume`: 16;
- `application_assistant`: 16;
- `reply_watch`: 16;
- `interview_practice`: 15.

Potential direction:

- use context-rich reads such as `get_application_workspace`,
  `get_pre_application_state`, and `get_resume_workspace` instead of forcing the model to chain
  multiple low-level list/get calls;
- keep account-management / connection-maintenance Operations out of normal career task Skills;
- split browser-session maintenance from research intent if Agent eval shows selection confusion.

These changes must be driven by Agent-native eval before/after, not by line-count aesthetics.

## CLI contract after this slice

Default:

```text
manifest
→ Skill catalog, zero Operation schemas
```

Scoped:

```text
manifest --skill <skill>
→ Operations for one Skill

ops --group <group>
→ only Agent-exposed Operations in that group
```

Audit/developer:

```text
manifest --all
ops --all
→ full Operation Registry
```

The CLI additionally reports separate counts:

```text
operation_registry_count
agent_tool_count
featured_tool_count
internal_operation_count
```

The old `operation_count` field remains as a backwards-compatible alias for Registry count.

## Safety boundary

Discovery remains projection, not authorization.

Nothing in this slice changes:

- Operation validation;
- `side_effects`;
- Proposal/HITL;
- Bridge grants;
- permissions;
- OperationAuditLog;
- Career Truth ownership.

An internal Operation hidden from Agent discovery can still be invoked by an authorized product
route or by exact developer/audit tooling.

## Evaluation plan

This change should be evaluated in two layers.

### Deterministic

- Agent surface is a strict subset of the Registry.
- Featured surface is a subset of Agent surface.
- Group discovery excludes internal/legacy route CRUD.
- `--all` still exactly exposes the Registry.
- removed entries are absent.
- legacy cover-letter HTTP route resolves to the canonical Operation.

### Agent-native

Using the real OMP RPC harness:

1. run representative tasks with the pre-change surface;
2. run the same frozen cases with Tool Surface V2;
3. compare:
   - Skill Top-1 / recovery;
   - schema loads;
   - Operation call count;
   - wrong-tool rate;
   - latency;
   - task pass@1 / pass^3;
   - safety hard gates.

Do not call a smaller catalog better unless outcome/reliability is at least preserved.

## External design references

The implementation direction follows current tool-design guidance:

- OpenAI Function Calling best practices recommend reducing the number of functions initially
  available, combining functions that are always called in sequence, and using tool search /
  delayed loading for large catalogs:
  https://developers.openai.com/api/docs/guides/function-calling
- OpenAI Tool Search recommends grouping delayed tools into clear namespaces and loading detailed
  definitions only when needed:
  https://developers.openai.com/api/docs/guides/tools-tool-search
- Anthropic recommends a small set of distinct, high-impact Agent tools rather than exposing every
  API endpoint, and specifically recommends context-rich tools that consolidate frequently chained
  calls:
  https://www.anthropic.com/engineering/writing-tools-for-agents

## Current verdict

```text
Registry breadth        = control-plane concern
Agent Tool breadth      = model-selection concern
Active Skill breadth    = per-task context concern
```

Tool Surface V2 optimizes the latter two without weakening the first.
