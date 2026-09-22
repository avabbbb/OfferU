> **HISTORICAL EVAL GUIDE.** This file predates the current Live Eval / real OMP RPC path and may mention manual API-key/runtime setup that is no longer the default product direction. Use `docs/evals/LIVE_EVAL.md`, `STATUS.md`, and PR #16 for current external-Agent validation.

# Real Agent E2E Test Guide

This document describes how to run a **real Agent E2E test** for OfferU's resume optimization feature.

## Prerequisites

1. **Agent runtime installed**:
   - Claude Code: `npm install -g @anthropic-ai/claude-code`
   - Codex CLI: `npm install -g @openai/codex-cli`
   - OMP: `npm install -g oh-my-pi`

2. **API key configured**:
   - Claude Code: `claude config set apiKey <your-key>`
   - Codex: `codex login`
   - OMP: `omp config set apiKey <your-key>`

3. **Backend running**: `cd backend && .venv312/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8766`

4. **Frontend running**: `cd frontend && npm run dev` (port 7410)

5. **Eval DB**: `H:\tmp\offeru\private-eval\eval.db`

## Running the Real Agent E2E Test

### Option 1: Claude Code

```bash
cd H:\WorkSpace_For_VsCode\Python\OFFERU\backend

claude --print --verbose --output-format stream-json --model sonnet "
You are an AI assistant helping with a job application task.

## Task
帮我看看这个字节 AIGC 产品经理岗位值不值得投，如果值得，帮我准备针对这个岗位的简历。

## Environment
- Working directory: H:\WorkSpace_For_VsCode\Python\OFFERU\backend
- Database: H:\tmp\offeru\private-eval\eval.db
- Frontend: http://127.0.0.1:7410
- Backend: http://127.0.0.1:8766

## Available Tools
Use bash tool to run OfferU CLI commands:

python -m app.cli doctor --pretty          # Check system health
python -m app.cli manifest --pretty          # List available skills  
python -m app.cli manifest --skill <id> --pretty  # Show skill details
python -m app.cli ops --pretty               # List all operations
python -m app.cli schema <op> --pretty       # Show operation schema
python -m app.cli run <op> --args '{\"key\":\"val\"}'  # Run operation
python -m app.cli confirm <run_id>           # Confirm proposal

## Rules
1. Discover skills first via manifest
2. Read operation schemas before calling
3. For mutations, check if confirmation required
4. Report what you did and the result

Start by checking system health and listing available skills.
"
```

### Option 2: Codex CLI

```bash
cd H:\WorkSpace_For_VsCode\Python\OFFERU\backend

codex exec --model o3 "
You are an AI assistant helping with a job application task.
...
"
```

### Option 3: OMP

```bash
cd H:\WorkSpace_For_VsCode\Python\OFFERU\backend

omp exec --model swe-2 "
You are an AI assistant helping with a job application task.
...
"
```

## What to Verify

### 1. Agent Autonomy

The Agent should **autonomously**:
- Discover available skills via `manifest`
- Read operation schemas via `schema`
- Call operations via `run`
- Handle confirmations via `confirm`

**NOT**: Pre-scripted operation sequence

### 2. Model-Issued Tool Calls

Verify the Agent actually issued tool calls:

```
Agent: I'll check the system health first.

→ bash: python -m app.cli doctor --pretty

Agent: I see the pre_application_decision skill is available.

→ bash: python -m app.cli manifest --skill pre_application_decision --pretty

Agent: Let me get the user profile.

→ bash: python -m app.cli run get_profile --args '{}'
```

### 3. Frontend Updates

While Agent works, open browser:
- `http://127.0.0.1:7410` — Today page
- `http://127.0.0.1:7410/#/jobs` — Jobs list
- `http://127.0.0.1:7410/#/jobs/1` — Job detail

You should see real-time updates as Agent calls operations.

### 4. HITL Flow

When Agent creates a proposal:
1. Frontend shows "需要你的确认"
2. You click "接受" or "拒绝"
3. Agent continues based on your choice

## Success Criteria

✅ Agent autonomously discovers and calls correct operations  
✅ No hardcoded operation sequence  
✅ Frontend updates in real-time  
✅ HITL confirmation works  
✅ Agent reports results clearly  
✅ Full trace logged for audit  

## Failure Indicators

❌ Agent doesn't call any OfferU operations  
❌ Agent calls wrong operations (e.g., skips skill discovery)  
❌ Frontend doesn't update  
❌ Agent can't handle confirmation flow  
❌ Agent doesn't report results  

## Comparison: Scripted vs Real Agent

| Scripted CLI Executor | Real Agent E2E |
|-----------------------|----------------|
| `if "resume" in prompt: call prepare_resume_optimization()` | Agent reasons about task, discovers skills, selects operations |
| Fixed sequence | Model decides sequence |
| No LLM involved | LLM makes decisions |
| Workflow test | Agent test |

## Next Steps

1. **Install Agent runtime**: Choose Claude Code, Codex, or OMP
2. **Configure API key**: Set up authentication
3. **Run real session**: Launch Agent with natural language task
4. **Verify trace**: Check that Agent actually called operations
5. **Observe frontend**: Watch for real-time updates
6. **Test HITL**: Confirm proposal acceptance/rejection flow

## Artifacts

- **Trace files**: `H:\tmp\offeru\live-eval-runs\agent\<run_id>\trace.json`
- **Prompt files**: `H:\tmp\offeru\live-eval-runs\agent\<run_id>\prompt.txt`
- **Screenshots**: `H:\tmp\offeru\eval-screenshots\`

## Troubleshooting

### Agent can't connect to backend
- Check backend is running: `curl http://127.0.0.1:8766/api/health`
- Check database path: `H:\tmp\offeru\private-eval\eval.db`
- Check CORS: `env | grep CORS`

### Agent doesn't call operations
- Check prompt includes tool instructions
- Check Agent has `bash` tool enabled
- Check CLI commands are correct

### Frontend doesn't update
- Check frontend is running: `curl http://127.0.0.1:7410`
- Check hash routing: `http://127.0.0.1:7410/#/jobs/1`
- Check database is same: `DATABASE_URL=sqlite+aiosqlite:///H:/tmp/offeru/private-eval/eval.db`
