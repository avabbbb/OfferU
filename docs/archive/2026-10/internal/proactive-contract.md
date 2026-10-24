> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：08-module-agent-runtime.md §8（位于 docs/）。本文是当时各切片共享的施工契约。

# Proactive Career Director — cross-slice implementation contract

Frozen seams every slice must share. Do not invent alternatives.

## Single runtime path
`AutomationEvent → AutomationRule → CareerTask(task_type="career_director") → _run_career_director → Codex turn → parse_career_briefing_response → _project_career_director_task → AutomationInboxItem → Today/Job Workspace`.

No second loop. No scheduler besides the existing daily-review route + emitters.

## Bounded context operations (read-only, Operation Registry, surface="career_director")
Each event type whitelists exactly its own context op in `_run_career_director.on_operation`:
- always: `get_career_snapshot`
- `DAILY_REVIEW`: + `get_daily_career_context(profile_id)`
- `JOB_SAVED`: + `get_job_assessment_context(job_id)`
- `INTERVIEW_*`: + `get_interview_career_context(calendar_event_id, automation_event_id)`
- `RESUME_UPDATED`: + `get_resume_reengagement_context(resume_id)`
- `WEEKLY_REVIEW`: + `get_weekly_career_context(profile_id)`

All target scoping is enforced by comparing requested ids to `task.input` ids (see existing pattern at career_tasks.py ~641-665).

## Briefing output blocks (offeru.career_briefing.v1)
Optional blocks the model fills only for its event:
- `job_assessment` — JOB_SAVED
- `interview_lifecycle` — INTERVIEW_* (mode prepare|debrief|learning_review)
- `resume_update` (ResumeUpdatePlan) — RESUME_UPDATED; every candidate.job_id MUST be in the dispatched `candidate_job_ids` set
- `weekly_review` (WeeklyReviewPlan) — WEEKLY_REVIEW
- `follow_up_plan` (FollowUpPlan) — for DAILY_REVIEW actions that draft follow-ups

## Dispatchers in automation.py
Add to `dispatchers` map in `_process_automation_event`:
- `RESUME_UPDATED: _dispatch_resume_updated`
- `WEEKLY_REVIEW: _dispatch_weekly_review`

Dispatchers: resolve ids from event payload → `start_career_task(task_type="career_director", runtime_provider="codex", input={automation_event_id, event_type, ...ids})` → `_upsert_inbox` fyi card.

## Emitters
- `RESUME_UPDATED`: emit inside `create_resume_version_record` and any path that commits a new `ResumeVersion` as `current_version_id`. dedupe_key=`resume-updated:{resume_id}:{version_number}`. Payload: `{resume_id, version_number, profile_id?}`.
- `WEEKLY_REVIEW`: emit from a new `/runtime/automation/weekly-review` route (same pattern as daily-review) plus scheduler hook; dedupe `weekly-review:{profile_id}:{iso_week}`.

## Validation gates inside `_run_career_director`
- RESUME_UPDATED: `resume_update.resume_id == input.resume_id`; every `candidates[].job_id` ⊆ dispatched candidate set; model cannot invent new job ids.
- WEEKLY_REVIEW: `weekly_review` required; `strategy_pack` must match stage track (already enforced by contract validator).

## Projection
`_project_career_director_task` already persists briefing → inbox. Add per-event blocks into `payload`: `resume_update`, `weekly_review`. Today page renders `briefing.actions` generically already — new blocks only need payload passthrough + a card where required.

## Safety
- Director ops are read-only; candidates/drafts remain proposals.
- No auto send/submit/contact. L3 → requires_user=True enforced by CareerAction validator.
- Dedupe + time-window + terminal-stage suppression happen in deterministic context code, never in the model.

## Tests
Each slice: synthetic DB fixture, stub `get_agent_runtime_provider` with a fake provider that calls the whitelisted ops then returns valid JSON for its block; assert event → task → inbox → payload round-trip, idempotency on duplicate event, and no Career Truth writes.
