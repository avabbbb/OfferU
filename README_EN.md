<p align="center">
  <img src="./asset/logo.png" width="112" alt="OfferU logo" />
</p>

<h1 align="center">OfferU</h1>

<p align="center">
  <strong>A local-first, evidence-driven, eval-first AI job-search workbench</strong><br />
  One set of career facts connecting job decisions, research, material proposals, application progress, interview practice, and auditable Agents.
</p>

<p align="center">
  <a href="https://github.com/avabbbb/OfferU/stargazers"><img src="https://img.shields.io/github/stars/avabbbb/OfferU?style=flat&logo=github" alt="GitHub stars" /></a>
  <a href="https://github.com/avabbbb/OfferU/issues"><img src="https://img.shields.io/github/issues/avabbbb/OfferU?style=flat" alt="GitHub issues" /></a>
  <img src="https://img.shields.io/badge/status-internal%20alpha-D97706?style=flat" alt="Internal alpha" />
  <img src="https://img.shields.io/badge/eval-baseline%20pending-64748B?style=flat" alt="Eval baseline pending" />
  <img src="https://img.shields.io/badge/license-MIT-2F855A?style=flat" alt="MIT License" />
</p>

<p align="center">
  <a href="./README.md">中文</a> ·
  <a href="#current-status">Current status</a> ·
  <a href="#the-core-user-loop">Core loop</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#eval-first-development">Evals</a> ·
  <a href="./docs/evals/deepseek-deep-test-prompt.md">DeepSeek test</a>
</p>

> [!IMPORTANT]
> OfferU is a local, single-user internal alpha—not a SaaS product. It never submits applications, sends email, or contacts third parties automatically. Agent output begins as a candidate or proposal and may change formal job-search state only after evidence gates and user confirmation.

<table>
  <tr>
    <td width="50%"><img src="./asset/screenshots/agent-workbench.png" alt="OfferU Agent workbench" /></td>
    <td width="50%"><img src="./asset/screenshots/job-research-handback.png" alt="Job-research evidence review" /></td>
  </tr>
  <tr>
    <td align="center"><strong>Task-bound Agent Runs, events, and confirmation</strong></td>
    <td align="center"><strong>Candidate claims, sources, and unknowns under review</strong></td>
  </tr>
</table>

## Start here

| Your goal | Recommended entry |
|---|---|
| Understand whom OfferU serves and why | [The core user loop](#the-core-user-loop) and [`CONTEXT.md`](./CONTEXT.md) |
| Run the product locally | [Quick start](#quick-start) |
| Understand the Agent, Registry, and safety boundary | [`Agent System`](./docs/architecture/agent-system.md) |
| Contribute or review architecture decisions | [`docs/README.md`](./docs/README.md) and the latest accepted ADR |
| Hand the full evaluation task to DeepSeek | [`DeepSeek deep-test prompt`](./docs/evals/deepseek-deep-test-prompt.md) |

## Current status

> [!NOTE]
> `internal alpha` describes the development stage only; it does not mean the core product has passed formal acceptance. OfferU still has no valid baseline conforming to [`offeru-core-v1`](./docs/evals/offeru-core-v1.md).

| Evidence ledger | Current conclusion |
|---|---|
| Current valid baseline | None; no report is accepted as formal evidence for the current revision |
| Verification in this update | Documentation only; no tests, builds, or external Agents were run, so there is no new product-pass claim |
| Next proof mechanism | When ready, the user manually gives the [full deep-test prompt](./docs/evals/deepseek-deep-test-prompt.md) to a fresh DeepSeek session; the project does not auto-launch an external Agent |

This README therefore reports evidence levels only. It does not infer user readiness from implementation, screenshots, old reports, or a single test run.

Status vocabulary: `PROVEN` means current valid eval evidence exists; `PARTIAL` means implementation or local evidence exists but the complete acceptance rules have not been met; `UNPROVEN` means no conclusive real run exists; `BLOCKED` means an environment or dependency prevented evaluation.

| Evaluation target | Current evidence state | What is still required for PROVEN |
|---|---|---|
| Operation / Skill control plane | `PARTIAL` | Machine-check live manifest schemas, dry-run, proposal/confirm, and cross-entry consistency |
| Built-in main Agent | `PARTIAL` | Three independent trials of context, routing, tool arguments, failure state, and final outcome |
| Frontend engineering surface | `UNPROVEN` | Obtain fresh typecheck=0 and build=0 evidence after the candidate syntax fix |
| Ordinary-user job-search loop | `UNPROVEN` | Complete the job → decision → materials → progress user journey on isolated data |
| Safety and human control | `PARTIAL` | Prove no Registry bypass, silent success, prompt-injection escalation, or credential leakage |
| Live DeepSeek/research/email integrations | `UNPROVEN` | Run the relevant integration tasks with the actual provider, authorized data, and traceable evidence |
| Alpha/beta release readiness | `UNPROVEN` | Pass every `required` task and provide real evidence for each integration claimed as available |

Older readiness assessments now live under [`docs/evals/reports`](./docs/evals/reports/README.md) as pre-eval evidence. Their findings are candidates to reproduce, not claims about the current revision.

## The core user loop

OfferU should let an ordinary job seeker complete this path without learning Agent, Operation, or workflow jargon:

```text
Select the current job
  → Ask “Is this role worth applying to?”
  → Reuse the confirmed career profile and current JD automatically
  → Produce an evidence-linked decision with unknowns and risks
  → User confirms apply / conditional apply / do not apply
  → Propose tailored materials using verified facts only
  → User reviews controlled form filling; never auto-submit
  → Track one application attempt and its stage events
  → Email signals remain candidates until the user confirms progress
```

This is the product's Golden Path and the center of `offeru-core-v1`. Real failures in this path—not the desire to add more pages—set engineering priority.

## Why “evidence-driven”

- Experience, skills, and preferences become formal career facts only when their source is traceable and the user confirms them.
- Job research retains sources, timestamps, and unknowns; external content is untrusted by default.
- Résumés, letters, decisions, and progress changes begin as reviewable candidates or proposals.
- Interview feedback and Agent inference are learning observations, not direct edits to career facts.
- Model calls, writes, and external actions pass through one Registry, authorization, confirmation, and audit boundary.

## Agent system

```text
React/Vite/Tauri UI ──> Python Agent Run Host ──> Pi SDK Worker
        │                         │                       │
        │                         └──── scoped tools ─────┘
        │                                      │
External IDE/CLI Agent ──> Skill + Machine CLI │
                                               ↓
                                      Operation Registry
                                               ↓
                          schema → auth → proposal → confirm
                                               ↓
                                    Python/SQLite facts
```

- **Python is the only business backend:** profile, job, material, application, interview, and audit facts remain in Python/SQL.
- **Pi SDK is the built-in Agent runtime:** it owns the session loop, model protocol, tool calls, and streaming—not business write authority.
- **External coding agents are replaceable hosts:** they discover the live contract before composing atomic Operations through the machine CLI/MCP.
- **Hosted heavy tasks are constrained sessions:** provider adapters return candidates and evidence, never direct career facts.
- **The DeepSeek Eval Agent is a test executor:** it may run repository checks and author a report; when DeepSeek is also under test, it cannot be the sole grader.

See [`Agent System`](./docs/architecture/agent-system.md) for the full boundary.

## Quick start

### Requirements

- Windows (the primary development environment today)
- Python 3.12
- Node.js and npm
- Rust/Tauri toolchain only when running the desktop shell

### 1. Backend

From the repository root:

```powershell
python -m venv backend/.venv312
backend\.venv312\Scripts\python.exe -m pip install -r backend\requirements.txt
Copy-Item .env.example backend\.env
backend\.venv312\Scripts\python.exe backend\run_server.py
```

Configure a provider in `backend/.env` or the settings UI when needed. Never commit API keys.

### 2. Frontend

In another terminal:

```powershell
npm --prefix frontend ci
npm --prefix frontend run dev
```

Open `http://localhost:7410`. The development port is fixed at `7410`. A port change must update both `dev/start` in `frontend/package.json` and `devUrl` in `frontend/src-tauri/tauri.conf.json`; `frontendDist` must remain the static `../dist` path.

### 3. Discover the live Agent contract

```powershell
Set-Location backend
.\.venv312\Scripts\python.exe -m app.cli doctor --pretty
.\.venv312\Scripts\python.exe -m app.cli manifest --pretty
.\.venv312\Scripts\python.exe -m app.cli ops --pretty
.\.venv312\Scripts\python.exe -m app.cli schema <operation_name> --pretty
```

Do not rely on drifting Operation counts, Skill counts, provider names, or model names in documentation.

## Eval-first development

Every claim that the product is “usable,” the Agent is “complete,” or a revision is “ready for alpha” must pass through:

```text
Real user task → fixtures → 1/3 trials → trajectory + outcome graders
               → eval report → human review → next engineering decision
```

Start here:

- [`Eval methodology and acceptance rules`](./docs/evals/README.md)
- [`OfferU Core v1: 24 tasks`](./docs/evals/offeru-core-v1.md)
- [`Full copy-paste DeepSeek deep-test prompt`](./docs/evals/deepseek-deep-test-prompt.md)
- [`DeepSeek IDE/CLI execution runbook`](./docs/evals/deepseek-runbook.md)
- [`Machine-readable report schema`](./docs/evals/report-schema.json)
- [`Report index`](./docs/evals/reports/README.md)

The user starts testing explicitly; neither OfferU nor Codex auto-invokes DeepSeek. Once a report returns, decisions follow this order: report integrity → critical safety/control failures → silent failures and error-state defects → required Golden Path blockers → authorized live integrations → subjective quality improvements.

## Documentation and repository layout

```text
OFFERU/
├─ backend/                  FastAPI, domain services, Registry, Agent Run Host
├─ frontend/                 React + Vite + Tauri
├─ agent-runtime/            Pi SDK worker/runtime bridge
├─ docs/
│  ├─ README.md              Documentation fact index
│  ├─ architecture/          Current architecture contract
│  ├─ adr/                   Append-only architecture decisions
│  ├─ evals/                 Prompt, suite, runbook, schema, and reports
│  ├─ agents/                Issue/triage/domain collaboration rules
│  ├─ design/                Machine-readable design assets
│  └─ archive/               Superseded plans, audits, and research
├─ CONTEXT.md                Domain language and product boundary
└─ AGENTS.md                 Agent development constraints
```

Use [`docs/README.md`](./docs/README.md) as the documentation entry point. Archived files do not prove current behavior.

## Eval-driven roadmap

1. Continue improving docs, fixtures, and isolation; the user decides when to launch a fresh DeepSeek deep test manually.
2. Have the main Agent validate report schema, redaction, and evidence before reviewing trace/outcome claims.
3. Make the local Golden Path pass three independent trials.
4. Fix one vertical slice at a time in the order critical safety/control → silent failures → core journey, turning each real fix into a regression task.
5. Validate research, materials, and email integrations last, then discuss new capabilities or UI polish.

## License

[MIT](./LICENSE)
