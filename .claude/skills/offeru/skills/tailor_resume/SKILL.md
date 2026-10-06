---
name: offeru-tailor-resume-method
description: Evidence-grounded method for preparing a reviewable resume for one canonical OfferU Job.
method_version: 1.0.0
---

# Job-tailored resume method

Use this method while the active OfferU Skill is `tailor_resume`. The active Agent drafts and reasons; OfferU supplies canonical context, fact gates, proposal persistence, version checks, review, and audit. Built-in and connected external Agents follow the same evidence and review rules.

## Inputs

- One canonical Job and its complete saved JD from `get_job`; confirm company and role identity from that Job itself.
- The canonical Profile and verified evidence from `get_profile` / `list_profile_evidence` or the exact equivalent in the live Skill.
- The selected source resume, its current version and sections from the live resume Operations, plus any current Job Workspace proposal or accepted material.
- Completed role/company research and its exact source references when relevant. Refresh current external claims before relying on them.

Read the live `tailor_resume` manifest and schemas. Use only the currently exposed Operations. If the selected Job or JD is missing or identity is ambiguous, stop that branch and report the gap; do not infer a company from adjacent listings.

## Method

1. Read the Job, Profile evidence, source resume, and current Job Workspace state before drafting. Preserve the source resume and note its current version/fingerprint when the Operation exposes one.
2. Turn the JD into a small requirement map. Retain literal JD excerpts and canonical Job references; distinguish explicit requirements from interpretation. Keep stale Job snapshot text distinct from fresh company or hiring information.
3. Map every proposed claim to verified Profile section IDs and source evidence. Mark support as strong, weak, missing, unknown, or under-expressed. Use existing language when it is accurate; do not convert participation into ownership, infer scope, or introduce metrics, tools, employers, dates, or outcomes without evidence.
4. Identify the few sections where a change would materially improve the match. Ask one decision at a time about unresolved positioning, order, or which experience to emphasize, compress, or omit. Explain the concrete trade-off. The answer is a drafting preference, not a Career Fact and not approval of unseen edits.
5. Draft section-level `Before` / `After` comparisons. For each material change preserve: the target requirement (literal JD excerpt), source Profile section IDs, why the wording fits, and the fact-gate status. Keep original content available and make no edits outside the chosen Job-tailored draft.
6. Before submitting, check that each row's `source_section_ids` name real verified evidence and that each rationale cites the exact requirement and explains the change. Use the current Operation schema for payload shape, source fingerprint, and any user-decision field. If the live Operations do not accept this Agent's evidence-backed draft, do not invoke a hidden writer or another model; leave the result as an explicitly unpersisted draft/partial and report the missing capability.
7. Persist only through the current Registry proposal path. Read back the concrete proposal and diff. Fact gates do not prove semantic accuracy, so keep the user's review of each material change. Ask responses, method output, and a successful draft call never accept the proposal. Adoption happens only through the independent OfferU review surface with current version checks and audit.

## Result and visibility

The reviewable result belongs in the existing Resume / Job Workspace proposal surface and contains the source Job and resume version, section-level before/after rows, exact evidence references, JD requirement excerpts, rationale, fact-gate state, and proposal status. Report `prepared`, `needs review`, `blocked`, `partial`, `adopted`, or `failed` only when the Operation readback supports that state. A chat-only draft is not a completed workspace result.

Refresh current role, company, process, compensation, or market claims using public/authorized sources and retain exact URLs and retrieval dates. Never send private Profile or resume text in a public query. If fresh research is unavailable, keep the conclusion partial and separate it from the saved Job snapshot. Third-party resume Skills may draft or critique; their output remains a draft and cannot write OfferU state or approve adoption.

