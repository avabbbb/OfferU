
# OfferU Architecture

Status: **CURRENT ARCHITECTURE AUTHORITY**  
Updated: 2026-09-23

OfferU is a local-first Career OS. The desktop product is the primary user experience; local Agents are replaceable reasoning engines attached to the same deterministic career control plane.

## System boundary

~~~
                    OfferU Desktop
          Today · Pipeline · Job · Profile
                         │
             guided intent / user action
                         │
              ┌──────────┴──────────┐
              │                     │
     External local Agent      OfferU fallback Agent
        (preferred)               (optional)
              │                     │
              └──────────┬──────────┘
                         │
         OfferU Skill + optional Career Skills
                         │
                  Agent Tool Surface
                         │
                Operation Registry
          schema · permission · proposal
             idempotency · audit
                         │
                  Career Runtime
      Profile · Job · Application · Resume
       Interview · Evidence · Events · Memory
                         │
                 local SQLite / files
~~~

Browser capture, email sync, automation and direct human UI actions join the same control plane; they do not maintain parallel business truth.

## Four authorities

- **Reasoning authority** — exactly one active Agent per Agent Run. Prefer a verified local Agent already owned by the user; OfferU may provide a fallback.
- **Execution authority** — the Operation Registry controls governed capabilities, validation, side effects, proposals, idempotency and audit.
- **Truth authority** — the Python Career Runtime owns persistent career state.
- **High-risk approval authority** — the user or an explicit deterministic product policy. An Agent cannot approve its own protected mutation.

## Agent hosts and Skills

Agent hosts may be Codex, WorkBuddy/CodeBuddy, Claude Code, OpenCode, OMP, Pi, Gemini or future compatible hosts.

OfferU detects host capability from code/probes rather than assuming parity. A host may be a Skill host, a hosted runtime/executor, both, unavailable or only partially compatible.

When the host supports Agent Skills, OfferU projects its Skill and allows composition with installed resume/recruiting/interview/career Skills. Third-party Skills provide methodology; OfferU remains the state and side-effect authority.

## Tool surface

The broad Operation Registry is **not** the model-facing tool list.

~~~
Operation Registry
  └─ Agent Tool Surface
      └─ Active Skill Surface
~~~

Agents discover compact Skill metadata first and load the relevant operation schemas on demand. Developer/audit paths may expose the full Registry, but beginner Agent flows should not.

See [Tool Surface V2](./docs/architecture/2026-09-22-tool-surface-v2.md).

## Truth flow

~~~
Observe
  ↓
Event / Evidence / Candidate
  ↓
Career Runtime validates / associates
  ↓
Agent or deterministic policy recommends next action
  ↓
Operation executes or creates Proposal
  ↓
review / confirmation when required
  ↓
verified state / artifact
  ↓
Today / Pipeline / Job / Profile re-project the same truth
~~~

Natural-language “done” is never the proof of completion.

## Browser and email

Default job acquisition is explicit current-page capture. Smart Fill may assist safe fields after review but never silently submits an application.

Email and other authorized channels create evidence/signals and reviewable progress candidates. They do not directly overwrite Pipeline state.

## Built-in runtime code

OfferU has one canonical embedded Agent kernel: the Pi SDK worker under `agent-runtime/`.

External Codex, OMP, Claude and other hosts remain replaceable reasoning/executor integrations. They must not create a second internal Agent kernel. In particular, Codex app-server support is retained for external-host discovery, conformance and bounded execution, not as a parallel OfferU-owned runtime.

The embedded Pi worker may adopt proven harness ergonomics such as persistent sessions, compaction, steer/follow-up, readiness checks and continuation controls while keeping Career Truth, permission and side-effect authority in Python.

Replay remains deterministic test infrastructure. Hosted executors remain bounded subtask infrastructure.

## Stable technology boundary

~~~
React / TypeScript = product UI
Python / FastAPI = Career Runtime + Operation Registry + deterministic policy
Tauri / Rust = desktop shell, lifecycle, installer and OS integration
Agent hosts/runtimes = replaceable reasoning/execution engines
SQLite = local career data
~~~

Do not introduce a second business backend or duplicate Career Truth to match an Agent framework.

## Safety invariants

- Agent output is candidate/draft until accepted through the correct path.
- Important state mutations are reviewable and auditable.
- External irreversible actions remain user-controlled.
- No Agent may self-confirm a protected proposal.
- Credentials do not enter Agent context.
- Provider/host failures are explicit.
- Browser/email integrations cannot create hidden business state.
- Historical eval or fixture success cannot be presented as current live capability.

Current product interaction authority: [Current Product North Star](./docs/product/current-product.md).
