# Autonomous Goal Decisions

Updated: 2026-08-27

## Stable decisions

1. `AgentRuntimeProvider` is the harness anti-corruption seam. Provider-specific lifecycle and event translation remain inside Adapters.
2. Main Agent UI consumes OfferU-owned Agent Run APIs and `AgentRunEvent`; it never branches on Pi, Codex, DSH, or Replay.
3. Codex integration uses App Server JSONL over stdio with initialize, Thread, Turn, Item, approval, interrupt, and terminal events. Human `codex exec` text is not a product protocol.
4. Codex protocol bindings are generated or validated against the installed Codex version; guessed DTOs are not a stable contract.
5. CareerTask, Operation Registry, Proposal/HITL, Audit, Automation policy, and provider health belong to the Career Control Plane.
6. Career Profile, Evidence, Memory, Job, Role Intelligence, Resume, Application, and Interview truth remain in OfferU Domain Runtime.
7. Capability Plugin is OfferU's versioned Manifest + Skill + executable contract. Codex Marketplace compatibility may be projected but is not the business contract.
8. Raw research and semantic extraction may be provider-driven; dedupe, cohort, frequency, ranking, Delta, persistence, and truth transitions are deterministic Runtime work.
9. Automation remains explicit Event -> Rule -> CareerTask -> Operation. No second infinite Agent loop is introduced.
10. Interview and Memory observations remain Candidate/Hypothesis until existing verification policy commits them.
11. Codex auth failures are provider health (`BLOCKED_EXTERNAL_AUTH`), not Role Intelligence or Career Runtime failures.
12. Jobs batch deletion and the compatibility batch-triage route are Operation Registry mutations; only ignored jobs can be permanently deleted, and route adapters do not own ORM commits.
13. The global control-plane audit is now an enforced source invariant: formal Career Runtime mutation routes consume typed Operation Registry helpers; direct reads and derived-only endpoints may remain direct, while local provider configuration is a separate system surface.
14. The route-layer audit is intentionally source-level as well as runtime-level: it rejects ORM mutators, SQL DML, and direct mutating service imports before browser or API tests run.
