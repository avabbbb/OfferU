# Migrated OfferU embedded Agent

Source: https://github.com/luyishui/OfferU
Commit: 3a446ff941da66000ba2cc24e5d2e5d19cd3a2e5 (2026-09-28).

`types.py`, `messages.py`, `hooks.py`, `loop.py`, `provider.py`,
`compaction.py` and `branch_summary.py` were copied from
`backend/app/agent/` at that commit, under the accompanying MIT LICENSE.
This is a source migration, not a replacement implementation of its loop.

Adaptations: provider configuration/security use this repository's LLM layer.
The Python session adapter runs the migrated loop inside the existing
AgentRun and Registry lifecycle. Upstream's `proposal_hook.py` (a Plan review
lock in `before_tool_call`) and its operator/SQL orchestrator are not used:
writes go through `app/services/action_gate.py` instead — ordinary writes run
and can be undone from the timeline, only irreversible ones are queued for one
user confirmation, and the Run never waits on it.

Pi sessions remain readable history. They are never silently converted into
Python sessions or replayed against business data.
