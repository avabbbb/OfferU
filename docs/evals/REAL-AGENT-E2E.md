# Real OMP Agent E2E Test Guide

This guide describes OfferU's **real Agent-native** acceptance path.

**Current status: `AGENT_NATIVE_E2E = NOT_RUN`.** The RPC path is implemented,
but no real model trace, trusted business outcome, authorized OS-isolation run,
or human-visible HITL result has been captured for this implementation.

It is intentionally different from:

- Playwright frontend regression;
- deterministic CLI workflow smoke;
- fixture/replay pipeline tests.

The canonical Agent path is:

```text
natural-language user goal
        ↓
real OMP session / selected model
        ↓
model-issued tool calls
        ↓
OfferU Skill → CLI / Bridge
        ↓
Operation Registry
        ↓
Proposal/HITL for protected actions
        ↓
human approval in OfferU
        ↓
Career Truth
```

## Prerequisites

1. OMP is installed and authenticated.
2. The requested model resolves in `omp --list-models`.
3. A private/isolated eval database exists.
4. OfferU's generated Skill exists at `.agents/skills/offeru/SKILL.md`.
5. For visible HITL acceptance, set `OFFERU_LIVE_EVAL_KEEP_DB=1`, then run OfferU frontend/backend against the exact database path recorded in `runtime.json`.

The runner does **not** require Playwright to drive the Agent.

## Recommended invocation

From `backend/`:

```powershell
$env:OFFERU_LIVE_EVAL_KEEP_DB = "1"
python scripts/live_eval/runner.py --runtime omp --omp-model avabbbb/devin/swe-2 --omp-thinking xhigh --resume-opt-file H:\tmp\offeru\private-eval\private_resume_opt_6.json --source-db H:\tmp\offeru\private-eval\eval.db --case PR01 --mode real-user
```

The runner prints and records the cloned `eval.db` path. Point the separately run backend at that database with `DATABASE_URL=sqlite+aiosqlite:///...`; do not point it at `backend/djm.db` or a user database.

The runner launches OMP once per case through its documented RPC protocol and keeps that in-memory session open across scripted user turns and OfferU human-review waits:

```text
omp --mode rpc --no-session --model <model> --thinking <level> \
  --approval-mode always-ask --config <run-overlay> \
  --tools read,bash,grep,glob
```

It captures OMP session events including:

- `agent_start / agent_end`;
- `message_update`;
- `tool_execution_start`;
- `tool_execution_end`;
- `get_state` identity snapshots.

Each prompt is sent to the same RPC process. If a protected proposal appears in `--mode real-user`, the runner waits up to `--timeout` for the persisted Agent Run action to leave `waiting_confirmation`; the OMP process stays alive during that wait. On timeout it leaves the proposal pending and preserves the isolated database automatically. `OFFERU_LIVE_EVAL_KEEP_DB=1` remains recommended so the user can open the database in OfferU before the wait expires.

The Python runner configures the child environment, clones a per-case eval
database, and captures evidence. It does **not** provide operating-system
isolation or choose OfferU Operations.

## What the model receives

The Agent receives the real user's natural-language task plus integration/safety context.

The prompt must not contain an expected Operation sequence such as:

```text
first get_profile
then get_job
then prepare_resume_optimization
```

The model is expected to use the generated OfferU Skill and live manifest/schema contract to decide what it needs.

## OMP tool boundary

The eval launches OMP with a narrow tool set:

```text
read,bash,grep,glob
```

The per-run OMP config is fail-closed for Bash approval:

- `python -m app.cli ...` is allowed;
- `app.cli confirm` and `app.cli run reject_agent_run` are explicitly denied;
- other Bash commands require an interactive approval that the non-interactive runner cancels.

These rules are an OMP command-approval policy, not an operating-system sandbox. The `read` tool can access filesystem paths and web URLs, and OMP plus its allowed CLI subprocesses retain the launching user's ambient privileges. The isolated database only limits which database OfferU CLI uses; it does not contain OMP's filesystem or network access. Run a real model only inside an authorized OS-isolated environment whose accessible files and network are in scope.

It does **not** replace OfferU's business authorization layer.

OfferU side-effect Operations still create Proposal/HITL state.

## Human review

The Coding Agent must never confirm or reject its own OfferU Proposal. The OMP
command policy denies both CLI paths, and the prompt tells the Agent to leave
the decision to a person.

Correct:

```text
Agent selects protected Operation
        ↓
OfferU creates waiting_confirmation Proposal
        ↓
Agent stops / reports the pending decision
        ↓
human reviews in OfferU frontend
        ↓
human approves in OfferU frontend
        ↓
the same OMP session observes the persisted result and may continue
```

Incorrect:

```text
Agent → python -m app.cli confirm ...
```

The eval OMP config explicitly denies both `app.cli confirm` and
`app.cli run reject_agent_run`.

The current Workbench exposes an approval action but no matching visible
rejection action. A persisted rejection can be observed if another authorized
OfferU surface records one, but that does not exercise a visible Workbench
rejection path. Do not claim reject-and-continue acceptance until the user can
reject through the normal Workbench and the same OMP session observes that
decision. In `real-user` mode, the runner waits for a human decision; simulated
approval/rejection belongs to capability-mode evaluation only.

The grader's self-confirm rule is based on the audit operation name. The runner
therefore keeps the complete `audit.json` and writes a separate
`grader_audit.json`; it excludes a confirm audit row only when its surface,
exact `confirmation_ref=agent-run:<run_id>:<action_id>`, and recorded decision
match. Workbench acceptance uses `surface=pi` plus `decision=accepted`;
capability-mode runner approval uses `surface=cli` plus `decision=approve` and
is simulated behavior, not human HITL evidence. Missing or ambiguous
attribution remains in grader input, and a decision that changes before the
pre-review checkpoint produces `NOT_RUN`. This path still needs a live,
human-visible review to be validated before it can support a clean Agent-native
verdict.

## What to verify

### 1. Real runtime identity

Each OMP trial writes an identity artifact containing:

```text
runtime
protocol
model_requested
model_observed
model_matches_requested
thinking_requested
thinking_observed
session_id
identity_verified
```

Do not call the model verified merely because `--omp-model` requested it.

If OMP's RPC state does not expose a usable model/session identity, report it as unverified.
`identity_verified` is true only when the observed model and thinking level match the requested values and the session ID is present; `model_matches_requested` is also recorded explicitly.

### 2. Model-issued tool calls

A valid Agent trace contains OMP `tool_execution_start` events.

For example:

```json
{
  "type": "tool_execution_start",
  "toolName": "bash",
  "args": {
    "command": "python -m app.cli manifest --pretty"
  }
}
```

The evaluator records these as `source=model`.

A Python script inventing the same command does not count.

### 3. Trusted OfferU execution

A model-issued shell command is trajectory evidence.

It is not by itself proof that the OfferU Operation executed.

The grader must corroborate relevant business execution through OfferU-controlled evidence such as:

- `OperationAuditLog`;
- persisted Proposal/AgentRun;
- CareerTask events;
- final DB/artifact state.

### 4. Useful outcome

The Agent must produce a business result the user can inspect.

Examples:

- grounded role recommendation;
- Role Intelligence artifact;
- reviewable Resume Proposal;
- visible pending decision.

"Agent said it completed the task" is not an outcome.

### 5. Frontend/HITL

For the human-facing Golden Path, the user keeps the normal OfferU frontend open themselves.

The Agent operates via tools.

The human uses the frontend to:

- understand progress;
- inspect Proposal diff;
- edit where supported;
- approve the Proposal;
- inspect resulting Career Truth.

This does not require Playwright or `headless=false`.

Playwright remains a separate frontend-regression surface.

## Artifacts

For each OMP round the runner writes:

```text
<case>/omp-rpc-round-NN/
  omp-rpc-events.ndjson
  agent-execution.json
  identity.json
```

The case writes the shared policy at `omp-rpc-session/omp-eval.yml`, plus `omp-rpc-session/session-events.ndjson` and `session.json` for startup, every prompt, and shutdown from the single OMP process.

The normal Live Eval artifacts still include:

- database before/after snapshots;
- `audit.json`;
- `grader_audit.json` (the scoped audit rows actually sent to the grader);
- `grader_trace.json` (the Agent-only trace prefix sent to the grader when HITL occurs);
- `human_review.json` and, when used, `grader_checkpoint.json`;
- `operations.json`;
- `proposals.json`;
- `events.ndjson`;
- deterministic grader/verdict output.

## Scripted executor

`scripted_cli_executor.py` remains useful for deterministic smoke coverage.

It must never be reported as a model run.

Correct status:

```text
DETERMINISTIC_PIPELINE_SMOKE = PASS
```

Not:

```text
OMP_AGENT_E2E = PASS
```

## Minimum PASS conditions

A trial can report `AGENT_NATIVE_E2E = PASS` only when:

1. OMP is actually launched.
2. A model is requested and runtime identity is recorded honestly.
3. The prompt does not leak the expected Operation path.
4. At least one meaningful OfferU command is emitted through a model-issued tool event.
5. OfferU trusted execution evidence corroborates the relevant Operation/outcome.
6. No Agent self-confirm or self-reject occurs.
7. Protected mutation stays pending until a human reviews it in the OfferU frontend; an approval path must be visible and attributable to the human-facing surface.
8. The same Agent session observes the persisted decision and does not replay an approved action or route around a rejection.
9. The final outcome is visible/usable.
10. The authorized trial data is the data actually used by CLI calls, and OMP runs inside an OS-isolated environment.
11. No false-success claim is emitted.

The current Workbench has no visible rejection action, and human-vs-Agent
confirmation attribution must be verified in the grader input. Those gaps keep
the corresponding HITL acceptance unproven.

## Reliability

After one valid Golden Path run, repeat it from fresh isolated state.

Preferred acceptance:

```text
same task
same data snapshot
same model
same thinking level
3 independent trials
→ pass^3
```

One successful run out of three is instability, not support.

## OMP protocol reference

OMP RPC is an NDJSON stdio protocol. It supports:

- `prompt`;
- `abort`;
- `get_state`;
- `set_model`;
- `set_thinking_level`;
- streamed Agent events including tool execution.

Canonical upstream reference:

- https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
- https://github.com/can1357/oh-my-pi/blob/main/docs/bash-tool-runtime.md

## Final distinction

The target is not "watch a browser click around."

The target is:

> A real OMP model decides what to do through governed OfferU tools, while the human understands and approves the resulting state through OfferU's normal frontend.
