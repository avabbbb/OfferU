# OfferU Agent Runtime Workers

This private Node.js package embeds `@earendil-works/pi-coding-agent` for the OfferU main Agent and `@anthropic-ai/claude-agent-sdk` for bounded hosted Claude tasks. These are runtime workers, not a business backend.

## Boundary

- Python owns tasks, Agent Runs, confirmations, idempotency, audit and domain facts.
- One active OfferU Agent Run maps to one in-memory Pi Session.
- Pi built-in filesystem and shell tools are disabled. The only Pi tool is `offeru_operation`.
- Python validates every Operation request against the Run grant and returns the result over the local process protocol.
- Provider credentials are injected into an in-memory Pi credential store and never written to Pi's global auth directory.
- One hosted Claude session belongs to one OfferU heavy task and may resume only with the same task snapshot, schema, working directory, and capability grant.
- The Claude worker permits only the explicitly granted public-web tools and denies shell, filesystem, sub-agent, Skill, and OfferU business access.

## Development

Requirements: Node.js 22.19 or newer.

```powershell
Set-Location agent-runtime
npm install --ignore-scripts
npm start
```

`src/worker.mjs` communicates through newline-delimited JSON on stdin/stdout using protocol `offeru.pi-worker.v1` and is managed by `backend/app/services/pi_agent_worker.py`.

`src/hosted-executor-worker.mjs` communicates through a separate newline-delimited JSON process contract and is managed by `backend/app/services/coding_agent_runtime.py`.

Do not expose either worker as a network service.
