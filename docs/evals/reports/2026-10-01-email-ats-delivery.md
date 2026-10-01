# Email / ATS delivery checkpoint

This is an implementation checkpoint, not end-to-end acceptance or release readiness.

## PR 1: trustworthy regression baseline

PR: https://github.com/avabbbb/OfferU/pull/46 (draft, not merged).

Main referenced absent resume design modules, so a clean-checkout email test run failed collection with `ModuleNotFoundError: app.services.resume_design`. The existing prerequisite restores those modules. The email fixture now redirects Career Memory to the same per-test SQLite session as email sync and application progress. The duplicate-poll test asserts observation persistence in that database and reuses the same observation IDs.

Validation in an isolated worktree based on `e1dbbaf` plus the prerequisite:

- Related backend suite: 50 passed, 12 datetime deprecation warnings.
- Final email suite after adding observation persistence assertions: 11 passed; no temporary plugin.
- Clean npm install, frontend typecheck: pass.
- Resume design panel and progress board tests: 4 passed.
- Production frontend build: pass.
- No real mailbox, real LLM classification, BOSS account or external application submission was used.
- Test storage, dependency cache and build worktree are on H:/tmp/offeru.

Commands:

```text
python -m pytest tests/test_email_incremental_sync.py tests/test_application_progress.py tests/test_application_actions.py tests/test_application_action_registry.py tests/test_job_sources.py tests/test_resume_design.py -q
python -m pytest tests/test_email_incremental_sync.py -q
npm ci --no-audit --no-fund
npm run typecheck
npm run test -- src/app/resume/components/ResumeDesignPanel.test.tsx src/components/progress-board.test.tsx
npm run build
```

Set `OFFERU_TEST_TEMP_ROOT` to an isolated H:/tmp/offeru directory and `PROGRESS_LLM_CLASSIFY=false` for backend regression.

## Merge blockers

Local focused checks do not override failed CI. The renewed PR run is https://github.com/avabbbb/OfferU/actions/runs/36808679294.

- Frontend job passes its build but fails the audit gate, including vulnerable transitive dependencies in the existing Pi runtime. Do not use audit-fix force or a major runtime migration without reviewing the dependency boundary.
- Extension job fails the architecture gate on `optimize_agent_chat_stream` bypassing the Operation Registry, rather than failing extension typecheck/DOM tests.
- The previous backend CI had Agent/Skill/CareerTask/release-boundary failures; the renewed backend job was still running at this checkpoint.

The user has been asked whether to include these prerequisite CI repairs or keep this delivery bounded and leave merging pending. No failed gate was disabled or bypassed.

## Remaining milestones

PR 2 and PR 3 are not implemented or accepted. The required ordering remains: merge PR 1, start the email closure from latest main, merge it, then start the single-ATS closure from latest main. Existing matching/review/timeline code has been inspected to plan reuse; that inspection is not an implementation claim.

Pending: same-company ambiguity, cross-account/thread binding, repeated/rejected suggestions, concurrent review and transaction failure tests; email→Job Workspace API/UI/restart evidence; then actual ATS filling/materials, user submission, trustworthy receipt and canonical progress. Real mailbox authorization remains Pending. Real external submission must wait for the user's explicit confirmation.
