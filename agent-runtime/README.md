# OfferU Agent Runtime Workers

Status: **INTERNAL EMBEDDED AGENT / BOUNDED EXECUTION INFRASTRUCTURE**

This private Node.js package owns OfferU's embedded Agent kernel and bounded hosted-executor support.

The embedded main Agent uses Pi SDK as its canonical in-product kernel. External hosts such as Codex/OMP/Claude remain optional replaceable hosts or bounded executors; Codex is not a second internal Agent kernel.

All reasoning paths still converge on the same Python Career Runtime and Operation Registry.

## Existing workers

- src/worker.mjs embeds @earendil-works/pi-coding-agent for the canonical embedded Agent path. It exposes persistent sessions plus steer/follow-up/compaction controls inspired by mature Pi/OMP harness UX without requiring an OMP/Bun migration.
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

src/worker.mjs uses the existing offeru.pi-worker.v1 local process protocol and is managed by backend/app/services/pi_agent_worker.py.

src/hosted-executor-worker.mjs uses a separate local process contract and is managed by backend/app/services/coding_agent_runtime.py.

Do not expose either worker as a network service.

Current Agent product authority: ../docs/architecture/agent-system.md.