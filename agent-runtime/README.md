# OfferU Agent Runtime Workers

Status: **OPTIONAL EXTERNAL EXECUTOR INFRASTRUCTURE**

This private Node.js package supports bounded external Claude hosted tasks.

The embedded main Agent uses the Python source migrated from `luyishui/OfferU` under `backend/app/agent/`. It does not start a Node/Pi worker. External hosts such as Codex/OMP/Pi/Claude remain replaceable hosts or bounded executors.

All reasoning paths still converge on the same Python Career Runtime and Operation Registry.

## Existing workers

- src/hosted-executor-worker.mjs uses @anthropic-ai/claude-agent-sdk for bounded hosted Claude tasks.

## Boundary

- Python owns Career Truth, Agent Runs, confirmations, idempotency, audit and domain facts.
- Workers do not directly write OfferU business state.
- Python validates Operation requests against the active Run grant.
- Provider credentials must not be persisted into another Agent's global auth store.
- Hosted executor sessions are task-scoped and cannot become a second Career OS truth or general main Agent.

## Development

Requirements: Node.js 22.19 or newer.

~~~powershell
Set-Location agent-runtime
npm install --ignore-scripts
npm start
~~~

src/hosted-executor-worker.mjs uses a separate local process contract and is managed by backend/app/services/coding_agent_runtime.py.

Do not expose this worker as a network service.

Current Agent product authority: ../docs/08-module-agent-runtime.md.
