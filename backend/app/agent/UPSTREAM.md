# Migrated OfferU embedded Agent

Source: https://github.com/luyishui/OfferU
Commit: 3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5 (2026-09-28).

`types.py`, `messages.py`, `hooks.py`, `loop.py`, `provider.py`,
`compaction.py`, `branch_summary.py` and `proposal_hook.py` were copied from
`backend/app/agent/` at that commit, under the accompanying MIT LICENSE.
This is a source migration, not a replacement implementation of its loop.

Adaptations: provider configuration/security use this repository's LLM layer;
proposal signatures/results use its Operation contract. The Python session
adapter runs the migrated loop inside the existing AgentRun/CareerTask and
Registry lifecycle. Upstream's operator/SQL orchestrator is replaced at that
boundary to retain one Career Truth and independent user approval.

Pi sessions remain readable history. They are never silently converted into
Python sessions or replayed against business data.
