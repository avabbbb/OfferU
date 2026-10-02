# OfferU Handoff

Updated: 2026-10-02

## Read first

Read `AGENTS.md`, `GOAL.md`, `docs/product/current-product.md`, `CONTEXT.md` and relevant current ADR/architecture documents, then [STATUS.md](STATUS.md). Product targets and implementation evidence are separate.

## Current continuation

The owner resumed S0/S1 implementation on 2026-10-02. S0 work is in isolated worktree `H:\tmp\offeru\s0-20261002\worktree`, branch `feat/s0-state-runtime-integrity`, from `588d86082e99323da15fb5dd584916d3d938471a`. The original checkout has existing changes; do not overwrite or reset them. Inspect actual Git status before continuing; these locations identify this checkpoint rather than permanent launch configuration.

Finish S0 before entering S1: truthful packet/resource readiness and Job projection; normal and abnormal Desktop shutdown; backed-up isolated clean reset without stale sessions returning; matching compiled Desktop/sidecar identity visible in the product. Build and run the current source package. A prior installer, seeded old build resource or passing unit test is not packaged-Desktop acceptance.

Native acceptance must include five consecutive normal closes plus forced host termination, backend startup failure, close during a Run and close with a pending Proposal. Preserve unrelated services. Automated tests use synthetic data and dedicated directories under `H:\tmp\offeru`.

After a separate S0 checkpoint, S1-A validates a real Provider, tools, structured Ask, independent protected-action review, same-Run continuation, cancellation and restart. Use the formal credential/vault path; never put keys in Git, logs or reports. S1-B starts only after its runtime prerequisites pass, using an owner-provided real Resume copy. Do not assume permission for other files, Agent Memory, accounts or external actions.

Keep results explicit: code exists, product path works and owner acceptance passes are distinct. Persist evidence and report unrun or failed gates. A model-issued Operation and user-visible result are required for Agent-native acceptance; scripted smoke and automated confirmation do not substitute for them.

## Historical context

The older branch, two-terminal source startup and proactive/Codex smoke checkpoint are [distilled in the archive](docs/archive/checkpoints/2026-09-27-proactive-career-director.md). Current product and runtime authority remain unchanged.
