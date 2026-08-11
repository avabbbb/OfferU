<p align="center">
  <img src="./asset/logo.png" width="112" alt="OfferU logo" />
</p>

<h1 align="center">OfferU</h1>

<p align="center">
  <strong>A local-first, evidence-driven AI job-search workbench</strong><br />
  Use one confirmed career profile to connect job decisions, tailored materials, application progress, interview practice, and auditable Agents.
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
  <a href="#quick-start">Quick start</a> ·
  <a href="#first-safe-trial">Safe trial</a> ·
  <a href="#using-offeru-with-an-external-coding-agent">Agent setup</a> ·
  <a href="#safety-boundaries">Safety</a> ·
  <a href="#evals-and-testing">Evals</a>
</p>

> [!IMPORTANT]
> OfferU is a local, single-user internal alpha—not a release-validated auto-apply product. It never submits applications, sends email, or contacts third parties automatically. Agent inferences, materials, and progress updates must begin as candidates or proposals and be reviewed and confirmed by the user.

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

## What OfferU is

OfferU organizes the job search into five connected stages:

1. **Today:** See the most important next actions, pending signals, and Agent tasks.
2. **Opportunities:** Save jobs, inspect JDs, research companies, and decide whether to apply.
3. **Materials:** Maintain a base résumé and propose role-specific versions using confirmed facts.
4. **Progress:** Record real application attempts, stage changes, email signals, and follow-ups.
5. **Interview:** Prepare questions, practice answers, and retain feedback as learning observations.

OfferU does not use public CSV files as its product database or require a separate static dashboard. The workbench reads local SQLite data through FastAPI. Agent and automation writes must pass through the Operation Registry, authorization, proposal, confirmation, and audit boundaries.

## Quick start

### 0. Prepare your environment

Windows is the primary development and trial environment:

- Git
- Python 3.12
- Node.js **22.19 or later**, with npm
- Rust/Tauri toolchain only when running the desktop shell

Download and extract the ZIP, or clone the repository:

```powershell
git clone https://github.com/avabbbb/OfferU.git
Set-Location OfferU
```

You can also give the repository URL to a coding Agent that can read local files. Ask it to read `AGENTS.md` before installing anything. Never paste API keys, résumé content, or other private data into a public Agent session.

### 1. Install dependencies

Run these commands from the repository root:

```powershell
py -3.12 -m venv backend\.venv312
backend\.venv312\Scripts\python.exe -m pip install --upgrade pip
backend\.venv312\Scripts\python.exe -m pip install -r backend\requirements.txt

npm --prefix agent-runtime ci
npm --prefix frontend ci

if (-not (Test-Path backend\.env)) {
  Copy-Item .env.example backend\.env
}
```

`backend/.env` is only a local configuration copy; it contains no usable model credentials. The UI can start without a provider, but model-backed features should fail visibly until one is configured. You can add a connection on the Settings page. Today, model connections are written to the git-ignored local `backend/config.json`; a masked value in the UI does **not** mean the on-disk value is encrypted.

### 2. Start the browser development build

Terminal A:

```powershell
backend\.venv312\Scripts\python.exe backend\run_server.py
```

Terminal B:

```powershell
npm --prefix frontend run dev
```

Open [http://localhost:7410](http://localhost:7410). The backend uses `127.0.0.1:8765` and the frontend uses `7410`.

If the browser reports `Failed to fetch` or a CORS error, first inspect the Windows user environment variable `CORS_ORIGINS` for obsolete ports. System environment variables take precedence over `backend/.env`.

### 3. Optional: start the desktop build

After installing the dependencies above and the Rust/Tauri toolchain, run this command from the repository root:

```powershell
npm --prefix frontend run tauri -- dev
```

The development desktop shell starts its own Vite and Python backend processes. Do not leave the two processes from step 2 running, or the fixed ports will conflict.

## First safe trial

Do not begin with a real application form. Use synthetic data or a copy with highly sensitive fields removed, then complete a read-only trial:

1. Configure a working model connection in Settings.
2. Import a **DOCX or text-based PDF** from onboarding or Profile/Résumé. Editable DOCX is easier to revise; scanned PDFs may require an additional OCR environment.
3. Review every extracted candidate fact. Education, experience, skills, and work authorization must not be guessed by a model.
4. Select an existing or test job in Opportunities, then open the OfferU Agent in the right context rail.
5. Ask: `Is this role worth applying to? List the evidence, unknowns, and risks. Do not perform any writes.`
6. Check that the answer used the current job and confirmed profile and that it labels missing information as unknown.
7. For a trial, do not confirm a write proposal or open a real application form.

> [!NOTE]
> The live Skill Registry may still mark some capabilities as `partial`. Do not treat job discovery, browser form recognition, or form filling as accepted merely because a page or endpoint exists. Use the live manifest and latest Eval report as the source of truth.

## Using OfferU with an external coding Agent

Claude Code, Codex CLI, and other local Agents must not duplicate OfferU business logic, edit SQLite directly, or invent hidden HTTP calls. Give the Agent this instruction first:

```text
Read AGENTS.md and .agents/skills/offeru/SKILL.md first.
Start from backend/.venv312 and run only doctor, manifest, and agent_playbook.
Report the live capabilities, partial items, and safety boundaries before acting.
Do not run a mutation, submit an application, send email, or contact any third party.
```

You can perform the same read-only discovery manually:

```powershell
Set-Location backend
.\.venv312\Scripts\python.exe -m app.cli doctor --pretty
.\.venv312\Scripts\python.exe -m app.cli manifest --pretty
.\.venv312\Scripts\python.exe -m app.cli agent_playbook --pretty
.\.venv312\Scripts\python.exe -m app.cli ops --pretty
```

Before invoking an Operation, read its schema and use dry-run. Do not treat Operation counts, Skill counts, provider names, or model names written in a README as live facts.

### Optional: give an external Agent browser tools

You do not need Playwright MCP to use the local OfferU UI, research jobs, or draft materials. Browser automation is necessary only when an external Agent must actually navigate a webpage, click, type, upload a file, or take a screenshot.

Claude Code:

```powershell
claude mcp add playwright npx '@playwright/mcp@latest'
```

Codex CLI:

```powershell
codex mcp add playwright -- npx -y @playwright/mcp@latest
codex mcp list
```

Restart the corresponding Agent session after installation. Check the current [OpenAI Codex MCP documentation](https://developers.openai.com/codex/mcp/) and [Microsoft Playwright MCP repository](https://github.com/microsoft/playwright-mcp) for authoritative setup details.

> [!WARNING]
> Installing Playwright MCP for Claude or Codex gives browser tools to that **external Agent host**. It does not inject those tools into OfferU's built-in Agent or expand the OfferU Registry's authority. OfferU must not currently be described as an autonomous universal job-form filler or submitter.

## Recommended workflow for real use

```text
Confirm career facts
  → Select the current job
  → Get an evidence-linked pre-application decision with unknowns and risks
  → User decides apply / conditional apply / do not apply
  → Propose tailored materials using verified facts only
  → User reviews and handles the real form
  → Record one application attempt and its stage events
  → Email or Agent signals remain candidate progress
  → User confirms before formal progress changes
```

Handling one company at a time is easier to audit. Saving a job, tracking it, drafting materials, or opening a form does not mean “submitted.” Update the record only after a real submission succeeds and leaves evidence that can be checked.

## Safety boundaries

An Agent must not:

- Guess identity, education, work authorization, salary, visa, or other legal facts.
- Fabricate experience, projects, skills, portfolio content, or research sources.
- Turn webpage text, email, interview feedback, or model inference directly into career facts.
- Bypass CAPTCHA, Cloudflare, anti-bot systems, two-factor authentication, or unknown-account login.
- Record “saved,” “tracked,” or “form opened” as “submitted.”
- Bypass the Operation Registry, dry-run, confirmation, audit, or data authorization.
- Click final submit, send email, or contact a third party without explicit user confirmation.

If automation reaches a CAPTCHA, login, legal declaration, salary, work-authorization question, or final submit button, it must stop and return control to the user.

## Privacy

OfferU is local-first, but “local-first” does not mean “all data is encrypted and never leaves the computer”:

- Career profiles, jobs, and progress primarily live in local SQLite. Do not assume the current database has at-rest encryption; protect the Windows account and disk.
- Model connections saved through Settings currently live in local `backend/config.json`. API responses mask the values, but that does not imply encrypted storage. Supported email connection secrets use the operating-system keyring.
- Never commit `backend/.env`, `backend/config.json`, databases, uploads, or real personal materials.
- Authorized data may be sent to the relevant provider when you use a cloud model, web research, email, or another external connection. Review the provider and data scope first.
- Do not publicly share a fork, screenshot, log, or Eval report that contains real personal data. Redact reports before sharing.
- For a product trial, prefer synthetic data or a copy with unnecessary fields such as government identifiers and home addresses removed.

`.gitignore` is only the last defense against accidental commits, not a privacy vault. Keep personal source files outside the repository and select them through OfferU's import flow.

## Current status and known limitations

| Area | Current conclusion |
|---|---|
| Development stage | Local, single-user internal alpha |
| Formal Eval baseline | No current valid baseline conforming to `offeru-core-v1` |
| Operation / Skill control plane | Implemented with partial evidence; live contract acceptance remains ongoing |
| Built-in main Agent | A runtime path exists, but one visible page or one answer does not prove full usability |
| Job discovery and browser form filling | Treat as not fully accepted; follow `partial` status in the live manifest |
| Automatic submission / email | Explicitly unavailable; final human control is mandatory |
| Release readiness | Unproven; do not market OfferU as an unattended job-search robot |

Historical assessments are reproduction leads, not proof that the current revision passes. See [docs/evals/reports](./docs/evals/reports/README.md) for report status and evidence levels.

## Evals and testing

Claims such as “usable,” “Agent complete,” or “ready for alpha” require real tasks, isolated fixtures, trajectory and outcome graders, visible failure states, and human review—not only static code inspection or a successful build.

Recommended entry points:

- [Eval methodology, loop, and acceptance rules](./docs/evals/README.md)
- [OfferU Core v1 task suite](./docs/evals/offeru-core-v1.md)
- [DeepSeek Loop Eval and test-report guide](./docs/evals/deepseek-loop-eval-guide.md)
- [Full copy-paste DeepSeek deep-test prompt](./docs/evals/deepseek-deep-test-prompt.md)
- [DeepSeek IDE/CLI execution runbook](./docs/evals/deepseek-runbook.md)
- [Machine-readable report schema](./docs/evals/report-schema.json)

Developers can run these checks manually:

```powershell
Set-Location backend
.\.venv312\Scripts\python.exe -m pytest tests -q

Set-Location ..
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

Browser and Agent E2E require a separately prepared runtime and explicit authorization. Green results from the commands above cannot substitute for that evidence.

## Documentation and repository layout

```text
OFFERU/
├─ backend/                  FastAPI, domain services, Registry, Agent Run Host
├─ frontend/                 React + Vite + Tauri workbench
├─ agent-runtime/            Pi SDK worker/runtime bridge
├─ .agents/skills/offeru/    OfferU Skill for external Agents
├─ docs/
│  ├─ architecture/          Current architecture contracts
│  ├─ adr/                   Architecture decision records
│  ├─ evals/                 Suite, runbook, schema, and reports
│  └─ agents/                Issue, triage, and domain conventions
├─ CONTEXT.md                Domain language and product boundary
└─ AGENTS.md                 Agent development constraints
```

Use [docs/README.md](./docs/README.md) as the full documentation entry point. Archived files and old screenshots do not prove current behavior.

## License

[MIT](./LICENSE)
