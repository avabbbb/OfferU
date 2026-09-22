# OfferU Real Agent-Native Acceptance

> Status: guidance / acceptance contract
>
> This document defines what OfferU may call **Agent-native E2E**. It is intentionally stricter than a frontend smoke test, deterministic CLI workflow, or fixture-backed pipeline test.

## Why this document exists

Recent local validation combined several individually useful checks into one "E2E" conclusion:

1. Playwright drove the OfferU frontend in managed headless Chromium.
2. A deterministic Python executor called `app.cli` Operations.
3. The backend state machine and HITL path produced the expected persisted state.

All three checks are useful.

They do **not** prove the product claim that a real Coding Agent such as OMP/SWE-2 can receive a natural-language career goal, discover OfferU Skills, choose Operations, call those Operations through OfferU's control plane, stop at protected human decisions, and continue from the resulting Career Truth.

The distinction matters because OfferU is intentionally agent-native. A scripted workflow that reproduces the expected Operation sequence can validate plumbing while bypassing reasoning, routing, tool-selection, recovery, and approval behavior.

> **A workflow may only be labelled Agent-native E2E when a verifiable model/harness makes the tool decisions.**

A deterministic script may be excellent test infrastructure. It is not the Agent.

---

# 1. Four different kinds of validation

These must be named separately in reports.

## 1.1 Frontend browser regression

Typical implementation:

~~~text
Playwright
→ navigate OfferU
→ click UI
→ assert rendered state
~~~

Validates routing, rendering, forms/buttons, frontend/backend integration, visible confirmation UI, and browser console/network regressions.

It does **not** validate Coding Agent reasoning, Skill selection, model-issued tool calls, CLI/Bridge discovery, Agent recovery, or model identity.

Expected label:

~~~text
FRONTEND_PLAYWRIGHT_FLOW = PASS
~~~

Do not call this Agent E2E.

## 1.2 Deterministic pipeline / CLI smoke

Typical implementation:

~~~text
Python/script
→ call known Operations in a predetermined sequence
→ inspect DB / result
~~~

Example:

~~~text
get_current_view
→ get_profile
→ get_job
→ prepare_resume_optimization
~~~

Validates CLI, Operation Registry, selected business services, Proposal/HITL plumbing, persistence/output invariants, and known workflow replay.

It does **not** validate whether SWE-2 chose those Operations, whether Skill discovery works, whether the Agent can choose another valid path, whether it recovers from an unexpected response, or whether it knows when not to use a tool.

Expected label:

~~~text
DETERMINISTIC_PIPELINE_SMOKE = PASS
~~~

Do not name a deterministic executor after a model/runtime unless it actually invokes that model/runtime.

## 1.3 Agent-native tool-use acceptance

This is the primary OfferU Agent acceptance path:

~~~text
User natural language
        ↓
Real Agent harness + verifiable model
        ↓
OfferU Skill discovery
        ↓
model-issued bash/tool call
        ↓
OfferU CLI / Bridge
        ↓
Operation Registry
        ↓
Career Runtime
        ↓
Proposal when protected
        ↓
Human confirms in OfferU UI
        ↓
Career Truth changes
        ↓
Agent observes the new state and continues
~~~

This validates the product claim that the Agent is actually operating OfferU.

Expected label:

~~~text
AGENT_NATIVE_E2E = PASS
~~~

Only use this label when all gates in this document pass.

## 1.4 Computer-use acceptance

A different product shape is:

~~~text
Agent
→ screenshot
→ mouse / keyboard
→ OfferU frontend
~~~

That can test computer-use agents, but it is **not OfferU's canonical Coding Agent integration**.

OfferU already has Skill Registry, CLI, Bridge, Operation Registry, Proposal/HITL, and AuditLog. A Coding Agent should use those governed surfaces rather than OCR/mouse-driving the app.

Do not use Computer Use to hide a broken CLI/Bridge integration.

---

# 2. Diagnosis of the current OMP eval executor

The current `backend/scripts/live_eval/omp_executor.py` is useful as deterministic smoke infrastructure, but it is not evidence of OMP/SWE-2 autonomy.

The executor currently performs logic equivalent to:

~~~text
request appears
→ Python reads prompt
→ fixed code calls get_current_view
→ fixed code calls get_profile
→ fixed code may call get_job
→ if prompt mentions resume/简历:
     fixed code calls prepare_resume_optimization
→ writes omp_result.json
~~~

The decision-maker is Python control flow, not SWE-2.

Therefore the path can prove:

~~~text
CLI invocation                         ✅
Operation Registry execution          ✅
known resume flow plumbing             ✅
request/result handoff plumbing        ✅
~~~

It cannot prove:

~~~text
OMP session actually ran               ❌
SWE-2 model identity                   ❌
model selected Skill                   ❌
model selected Operation               ❌
model adapted to result                ❌
model stopped for human approval       ❌
model resumed after approval           ❌
~~~

Recommended classification:

~~~text
scripted_cli_executor
or
deterministic_eval_executor
~~~

If the filename remains `omp_executor.py`, reports must still state that it is a scripted external executor and does not instantiate OMP/SWE-2.

---

# 3. Playwright is not the problem

The repository rule requiring managed Chromium + `headless=true` for automated browser validation is reasonable for unattended regression tests.

A headless Playwright run is not invalid because the user cannot watch it. The classification is the problem.

Use Playwright for:

~~~text
frontend regression:
Playwright → PASS/FAIL
~~~

Use the real Coding Agent for:

~~~text
Agent-native acceptance:
Coding Agent → OfferU Skill/CLI/Bridge → Operations
~~~

The user may simultaneously open the normal OfferU frontend themselves to observe state, edit artifacts, and approve protected actions.

That is normal product use, not automated browser validation. The Agent does not need to launch a visible browser.

---

# 4. Canonical Golden Path

The first real Agent-native acceptance should be deliberately small.

## User goal

Use one explicitly authorized Career Profile / resume snapshot and one real target JD.

Natural-language task:

> 帮我判断这个岗位值不值得投。如果值得，帮我准备针对这个岗位的简历；需要我决定或确认的地方再叫我。

Do not leak expected Operation names into the prompt.

## Expected Agent behavior

A valid path may look like:

~~~text
SWE-2
│
├─ model-facing bash
│   python -m app.cli doctor --pretty
│
├─ model-facing bash
│   python -m app.cli manifest --pretty
│
├─ decides which Skill is relevant
│
├─ model-facing bash
│   python -m app.cli manifest --skill <chosen-skill> --pretty
│
├─ inspects relevant schemas
│
├─ executes grounded reads
│
├─ forms recommendation / preparation plan
│
└─ invokes a protected preparation Operation
       ↓
     Proposal created
       ↓
     Agent stops
~~~

The evaluator must not require one exact Operation path if multiple legal paths satisfy the outcome and invariants.

---

# 5. Human-facing frontend role

During the same run, the user can keep OfferU open normally.

The frontend is primarily for:

- observation;
- comparison;
- editing;
- rejection;
- approval;
- truth inspection.

The frontend does not need to be the Agent's mouse target.

Expected interaction:

~~~text
Agent prepares Proposal
        ↓
OfferU frontend shows pending review
        ↓
User reviews / edits / accepts / rejects
        ↓
Career Truth updates
        ↓
Agent reads resulting state
        ↓
Agent continues
~~~

Intended division:

~~~text
Agent      = reasoning / preparation
Registry   = governed execution
Frontend   = human understanding / approval
Runtime    = Career Truth
~~~

---

# 6. Required evidence for Agent-native E2E

An Agent-native report must preserve process evidence and outcome evidence separately.

## 6.1 Runtime/model identity

Record:

~~~text
agent host
runtime/harness
requested model
observable/reported model
thinking/effort when observable
session/run id
~~~

Never infer actual model identity solely from a provider alias.

If actual identity cannot be verified, report:

~~~text
MODEL_IDENTITY_UNVERIFIED
~~~

and do not claim "SWE-2 verified".

## 6.2 Model-issued tool calls

Preserve harness-native events proving the model requested the command.

For OMP this means the model-facing `bash` tool-call surface, not user `!cmd` execution and not a Python script inventing the command.

Conceptually:

~~~json
{
  "tool": "bash",
  "source": "model",
  "command": "python -m app.cli ..."
}
~~~

The exact serialization may differ by harness.

## 6.3 Trusted execution evidence

Model text is not proof that an Operation executed.

Corroborate execution with OfferU-controlled evidence such as:

- OperationAuditLog;
- persisted Proposal/AgentRun;
- CareerTask event;
- DB state;
- trusted CLI result envelope.

Use:

~~~text
model requested X
+
OfferU audit shows X
=
X actually executed
~~~

Do not accept:

~~~text
echo "python -m app.cli run X"
~~~

as execution evidence.

## 6.4 Outcome evidence

The final claim must be based on user-visible/business state.

Examples:

~~~text
Role Intelligence artifact exists
Resume Proposal exists
Proposal is reviewable
Resume version exists after approval
Career Truth is unchanged before approval
Job A state does not leak into Job B
~~~

The Agent's final sentence is not the outcome.

---

# 7. Approval boundary acceptance

A protected Operation must not be self-confirmed by the Agent.

Expected:

~~~text
Agent invokes protected Operation
        ↓
OfferU persists Proposal
        ↓
Agent reports waiting for review
        ↓
User acts in OfferU UI
        ↓
approval state changes
        ↓
Agent may continue
~~~

Forbidden in the current product contract:

~~~text
Agent:
python -m app.cli confirm <run_id>
~~~

The current generated OfferU Skill already instructs external Agents not to self-confirm; the E2E must verify that this is actually respected.

---

# 8. Multi-turn acceptance

A real Agent integration must survive more than one happy-path turn.

Minimum sequence:

~~~text
Turn 1:
Prepare for Job A.

Turn 2:
Reject one proposed change; keep the rest.

Turn 3:
User corrects one Career Profile fact.

Turn 4:
Continue.

Turn 5:
Switch to Job B.
~~~

Verify:

- current Job identity is correct;
- rejected suggestion stays rejected;
- stale Proposal handling works;
- updated Career Evidence is reused;
- Job A details do not leak into Job B;
- Agent does not repeat already-completed work unnecessarily.

---

# 9. Cancellation and late-result acceptance

For a long-running Agent task:

1. start the run;
2. interrupt/cancel it;
3. allow any late model/subprocess output to arrive;
4. verify the cancelled run cannot mutate Career Truth;
5. verify a late result cannot satisfy a later trial;
6. verify no duplicate artifact/event is created.

Every handoff result should be bound to at least:

~~~text
trial/request id
case id
run/session identity
isolated data identity
~~~

---

# 10. Data isolation

Agent-native evaluation must use an explicitly authorized data projection.

A cloned DB is necessary but not sufficient if the Agent can read unrelated local files.

Prefer:

~~~text
authorized Profile/Resume/Job snapshot
        ↓
isolated eval workspace
        ↓
isolated DB
        ↓
Agent session
~~~

Do not give an Agent broad filesystem access and call the test private merely because `DATABASE_URL` points to a clone.

Report which user data was authorized for the trial.

---

# 11. Frontend observation acceptance

The user should be able to understand what the Agent is doing from OfferU.

The normal UI should answer:

- What is currently being prepared?
- What has completed?
- What is degraded/blocked?
- What needs my review?
- What will change if I approve?
- What happened after approval?

The normal UI does not need to expose raw tool calls. Developer/advanced diagnostics may expose them separately.

---

# 12. Correct status vocabulary

Reports must keep dimensions separate.

Example:

~~~text
DETERMINISTIC_PIPELINE_SMOKE = PASS
FRONTEND_PLAYWRIGHT_FLOW     = PASS
OPERATION_REGISTRY_PATH      = PASS
PROPOSAL_HITL_PATH           = PASS

AGENT_NATIVE_E2E             = NOT_RUN
MODEL_IDENTITY               = UNVERIFIED
MODEL_TOOL_SELECTION         = NOT_VERIFIED
VISIBLE_AGENT_HITL_LOOP      = NOT_VERIFIED
~~~

Only upgrade `AGENT_NATIVE_E2E` after the real Agent run.

---

# 13. Minimum Agent-native acceptance gates

A run may report `AGENT_NATIVE_E2E = PASS` only when all are true:

1. A real Agent harness/session is instantiated.
2. Requested/actual model identity is recorded honestly.
3. The user prompt does not leak the expected Operation path.
4. Skill/capability selection is made by the Agent.
5. At least one meaningful OfferU Operation is requested by a model-issued tool call.
6. The Operation is corroborated by trusted OfferU execution evidence.
7. A useful user-visible outcome exists.
8. Protected mutation produces Proposal/HITL rather than self-confirmation.
9. Human approval/rejection is visible in OfferU.
10. The Agent can observe resulting state and continue or stop correctly.
11. The trial uses isolated/authorized data.
12. No false success is reported.
13. Job/task identity remains correct across turns.
14. Cancellation/late result cannot corrupt the outcome.
15. The user can inspect/use the final artifact.

---

# 14. Recommended implementation sequence

## Phase 1 — Reclassify existing scripted executor

Keep deterministic coverage if useful.

Make the contract honest:

~~~text
scripted workflow
deterministic smoke
no model autonomy
~~~

Do not delete useful smoke coverage merely because it is not an Agent.

## Phase 2 — Real OMP/SWE-2 runner

Create a runner that starts or attaches to a real OMP Agent session.

Requirements:

- explicit model selection;
- explicit working directory;
- OfferU Skill available;
- model-facing bash tool enabled;
- isolated eval data;
- structured event capture;
- session/run identity;
- timeout/cancel;
- no scripted Operation chooser.

The runner provides environment and captures events. It must not decide which Career Operation should run.

OMP already has a distinct model-facing `bash` tool-call surface. Use that surface rather than a watcher that synthesizes CLI commands.

## Phase 3 — Trusted trace binding

Bind:

~~~text
model tool-call event
↔ CLI command
↔ OperationAuditLog
↔ Proposal/DB outcome
~~~

This is the evidence chain.

## Phase 4 — Visible HITL Golden Path

Run the one-JD task while the human uses the normal OfferU frontend.

The Agent operates through tools.

The user observes/edits/approves through UI.

Do not automate the human approval with Playwright for this acceptance.

A separate Playwright regression may verify the approval UI itself.

## Phase 5 — pass^3 reliability

After one valid run, execute the same acceptance three independent times against fresh isolated state.

Same model, host, task, data snapshot, and rubric.

Report `pass^3`. Do not turn 1/3 into "supported".

---

# 15. Guidance for the current assisted-apply PR

The Connector Registry work and Eval experimentation solve different problems.

Recommended review boundary:

## Keep in the assisted-apply PR

- ApplicationActionConnector registry;
- capability matrix;
- read-only discovery Operation;
- Skill projection changes;
- connector-focused tests.

## Treat separately as Eval work

- scripted `omp_executor.py`;
- resume eval suite;
- runner changes specific to external-executor handoff;
- grader changes;
- E2E report.

If those Eval files remain in the same PR, the PR description/report must explicitly state that the current executor is deterministic workflow infrastructure and does not prove SWE-2 Agent behavior.

Prefer a separate Agent-native Eval PR so Connector review is not coupled to Harness experimentation.

---

# 16. Anti-patterns

Do not claim Agent-native E2E from any of the following alone:

~~~text
Playwright clicked the UI

Python selected Operations from prompt keywords

CLI commands were listed in a report

Agent final text says it completed the task

fixture research completed

Proposal exists but no Agent selected the Operation

model name is hardcoded in result JSON

a handoff file is named omp_result.json
~~~

Names are not evidence.

Trusted runtime events + OfferU execution evidence + final environment outcome are evidence.

---

# 17. Report template

Future Agent-native reports should include:

## Identity

~~~text
Commit:
Eval version:
Agent host:
Harness/runtime:
Requested model:
Observed model identity:
Session/run id:
Data snapshot:
~~~

## User goal

Exact natural-language prompt.

## Agent trajectory

Only high-level tool decisions, never private chain-of-thought.

~~~text
Skill discovered:
Operations requested:
Operations audit-confirmed:
Proposal created:
Human action:
Continuation:
~~~

## Outcome

~~~text
Artifact/state:
User-visible location:
Career Truth before:
Career Truth after:
~~~

## Independent regressions

~~~text
Frontend Playwright:
Deterministic CLI smoke:
Backend tests:
~~~

## Verdict

~~~text
AGENT_NATIVE_E2E:
MODEL_IDENTITY:
DATA_IDENTITY:
HITL:
OUTCOME:
~~~

## Limitations

Explicit blockers and unverified claims.

---

# 18. References

- OMP bash runtime distinguishes model-facing bash tool calls from user bang/RPC shell helpers:
  https://github.com/can1357/oh-my-pi/blob/main/docs/bash-tool-runtime.md
- OMP model-facing bash tool:
  https://github.com/can1357/oh-my-pi/blob/main/docs/tools/bash.md
- Anthropic, "Demystifying evals for AI agents", distinguishes trajectory/transcript from final environment outcome and explains agent/eval harness boundaries:
  https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

---

# 19. North star

The goal is not to make Playwright visible.

The goal is not to make the CLI look human.

The goal is:

> **A real Agent decides what to do through governed OfferU tools, while the human can understand, edit, approve, and trust the resulting Career state in the normal frontend.**

That is the OfferU product claim worth validating.
