# OfferU Deterministic Pipeline Smoke Report

**Date**: 2026-09-22  
**Scope**: Deterministic validation of resume optimization pipeline (NOT Agent E2E)  
**Environment**: Local dev (frontend `7410`, backend `8766`, isolated eval DB)

---

## ⚠️ Critical Clarification

This report documents a **deterministic pipeline smoke test**, not an Agent-native E2E eval.

| What this tested | What this did NOT test |
|------------------|------------------------|
| Backend CLI operations work | SWE-2/OMP Agent reasoning |
| Frontend displays data correctly | Agent tool selection |
| HITL gates enforce order | Real LLM optimization quality |
| Manual decision fallback works | Agent-initiated Operation calls |
| Resume saves to DB | Model identity verification |

**This is a workflow test, not an Agent test.** The `scripted_cli_executor.py` (formerly `omp_executor.py`) executes a fixed sequence of CLI calls based on prompt keywords — it does not launch OMP/SWE-2 or let the model decide which operations to call.

---

## Eval Design

### Test Data

| Component | Source | Count |
|-----------|--------|-------|
| User Profile | Real resume (parsed) | 8 sections |
| Target Jobs | Real JDs (BAT companies) | 3 positions |
| Research Runs | Fixture mode (deterministic) | 3 completed |
| Eval Cases | Custom scenarios | 6 cases |

### Eval Cases

| Case | Journey | Target | Focus |
|------|---------|--------|-------|
| PR01 | Resume tailor | ByteDance AIGC PM | Full pipeline |
| PR02 | Resume tailor | Tencent Agent Dev | Full pipeline |
| PR03 | Revision context | Auto-pick | Context preservation |
| PR04 | Fact gate | Auto-pick | Safety validation |
| PR05 | One-page constraint | ByteDance AIGC PM | Length control |
| PR06 | Resume tailor | Alibaba Enterprise PM | Full pipeline |

---

## Pipeline Validation Results

### Step 1: Onboarding
- 4-question career profile assessment (MBTI-style)
- **Result**: ✅ Profile initialized

### Step 2: Profile Page
- User resume data correctly loaded
- **Result**: ✅ All 8 verified_fact sections displayed

### Step 3: Jobs List
- Job pool correctly filtered and displayed
- **Result**: ✅ Target jobs accessible (after fixing triage_status)

### Step 4: Job Detail
- JD content displayed
- Decision gate status visible
- Material candidate shown
- **Result**: ✅ Complete job context available

### Step 5: Pre-Application Decision
- Manual decision path functional
- **Result**: ✅ "Go" decision recorded

### Step 6: Resume Workspace
- Proposal editable in structured editor
- **Result**: ✅ User can review and modify proposal

### Step 7: Save & Confirm
- "Save version" persists changes
- **Result**: ✅ Resume 1 saved, `target_job_id` set

---

## Technical Validation

### Backend Pipeline
```
prepare_resume_optimization → fact_gates_passed → proposal_ready → user_confirm → resume_created
```

| Check | Status |
|-------|--------|
| Profile loaded | ✅ |
| Job research completed | ✅ |
| Fact gates passed | ✅ |
| Proposal generated | ✅ |
| User confirmation required | ✅ |
| Resume persisted | ✅ |

### Frontend Integration (Playwright headless)
| Surface | Status |
|---------|--------|
| Onboarding flow | ✅ |
| Profile display | ✅ |
| Jobs list | ✅ |
| Job detail | ✅ |
| Decision gate | ✅ |
| Resume workspace | ✅ |
| Save action | ✅ |

---

## Issues Found & Resolved

| Issue | Severity | Resolution |
|-------|----------|------------|
| Jobs not in list | Medium | `triage_status` needed "inbox" not "pending" |
| Pool assignment missing | Medium | Assigned `pool_id=1` to eval jobs |
| Frontend cache stale | Low | Hard refresh required |
| Decision gate needs LLM | By design | Manual fallback path works |

---

## What This Proves

✅ **Pipeline integrity**: The backend correctly processes profile → job → decision → proposal → resume  
✅ **Frontend rendering**: The UI correctly displays eval data and enforces HITL gates  
✅ **Safety boundaries**: Fact gates prevent invalid proposals; manual confirmation required  
✅ **Data persistence**: Resume saves correctly with job linkage  

## What This Does NOT Prove

❌ **Agent reasoning**: No LLM was involved in operation selection  
❌ **Tool selection**: Operations were hardcoded, not model-chosen  
❌ **Real optimization**: Fixture mode used, no actual LLM rewrite  
❌ **Quality assessment**: No scoring against ground truth or user preferences  
❌ **Error handling**: Happy path only, no failure recovery tested  
❌ **Concurrent access**: Single user, single session only  

---

## Next Steps for Real Agent E2E

The repository now contains an OMP RPC harness in `agent_executor.py`; the
runner is designed to keep one in-memory RPC session per case across turns and
human-review waits. This implementation has not yet been validated with a live
model in OS isolation.

`AGENT_NATIVE_E2E` remains `NOT_RUN`. Acceptance still needs runtime evidence and
the following product/evidence gaps resolved:

1. **Run real OMP/SWE-2**: execute the RPC harness against the private eval snapshot
2. **Verify model identity**: compare requested selector with RPC `get_state`
3. **Verify model-issued tools**: require `tool_execution_start` events for OfferU CLI
4. **Corroborate outcome**: bind tool events to OperationAuditLog / Proposal / DB state
5. **Visible HITL**: user reviews and approves in the normal OfferU frontend; capture the actual human-facing result
6. **Rejection + continuation**: Workbench currently has no visible rejection action, so this path is not covered
7. **Audit attribution**: verify exact `surface` / `confirmation_ref` attribution in `grader_audit.json` (`pi` for Workbench approval; capability-only simulated `cli` approval) while preserving the complete `audit.json`
8. **Isolation**: run OMP in authorized OS-level isolation; the per-case SQLite clone and Bash policy are not host isolation
9. **Multi-turn / pass^3**: repeat from fresh isolated state

---

## Artifacts

| Artifact | Location |
|----------|----------|
| Eval DB | `private-eval/eval.db` |
| Ground truth | `private-eval/ground_truth.json` |
| Eval cases | `private-eval/private_resume_opt_6.json` |
| Screenshots | `eval-screenshots/` |
| Report JSON | `e2e_report.json` |
| Scripted executor | `backend/scripts/live_eval/scripted_cli_executor.py` |

---

## Conclusion

This deterministic pipeline smoke test confirms the OfferU resume optimization **backend pipeline and frontend integration work correctly**. The HITL flow is enforced, data persists properly, and safety gates function as designed.

However, this is **not an Agent E2E test**. To validate the true Agent-native experience — where SWE-2 reasons about user goals, discovers Skills, selects Operations, and calls CLI tools autonomously — a separate eval with real OMP session and model-issued tool calls is required.

**Status**: ✅ Deterministic pipeline validated | 🧪 OMP RPC harness implemented but not live-validated | ⚠️ `AGENT_NATIVE_E2E = NOT_RUN` until a live model trace, trusted outcome, authorized OS-isolation evidence, correctly attributed human-visible HITL result, and the required UI path are captured
