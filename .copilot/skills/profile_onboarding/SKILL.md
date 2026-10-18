---
name: offeru-profile-onboarding-method
description: Four-step method for initializing the canonical OfferU Profile and handing off to resume tailoring.
method_version: 1.1.0
---

# Profile onboarding method

Use this method while the active OfferU Skill is `profile_onboarding`. It guides whichever single Agent is reasoning; it adds no Operations, profile store or write path. Read the live Skill manifest and each Operation schema before use; if an Operation named here is not exposed, skip that step and say which capability is missing.

## Done when

Onboarding is complete when OfferU holds at least one `verified_fact` Profile entry, one target role, and one saved Job. Then stop asking questions and hand off to `tailor_resume`. A narrower user goal (for example only fixing one gap) ends when that goal is met.

## Step 1: read what exists

Call `get_current_view`, then `get_profile` (and `list_profile_evidence` when you need sources). Count only `verified_fact` entries as established. Never ask for anything OfferU already holds, and skip any step below whose outcome already exists.

## Step 2: ask the career stage

Ask one single-choice question with the host's native Ask tool: campus hire, internship, experienced hire, or career change. Mark a recommended option when the Profile suggests one, and allow skipping. If the user skips, pick the closest default, say which one you assumed, and continue. Later questions and suggestions follow this stage.

## Step 3: build the Profile

Offer two paths and recommend the first:

1. Upload an existing resume in OfferU. Parsed entries are written directly as `verified_fact`; entries parsed with low confidence (below 0.6, or missing an organization or body) are flagged for a second look. Read the Profile back after the upload, then ask only about flagged entries and missing fields. Tell the user the whole import can be undone in one step (`undo_profile_resume_import`).
2. Write a few experiences by hand (work, internship, project). Save each through `add_profile_evidence` only after the user states it is their real experience.

Ask one concrete question at a time: what the user did, their own part, the result, and where it can be checked. Never push for invented numbers; keep an unavailable result qualitative or unknown. Do not strengthen ownership, dates, metrics, technologies or outcomes beyond what the user or the document states. Host memory or third-party Skill output is a lead, not evidence; route it through `create_memory_proposal` instead of writing it as fact.

## Step 4: target role and first Job

Create the target role with `create_target_role`. Then ask the user to paste one job description or link and call `draft_job_posting`. If it returns `needs_text` (BOSS直聘 and other login-walled sites), ask the user to copy the posting text; never fetch it another way. Show the draft, let the user fill gaps, then save it with `import_jd`.

## Reporting

Report in plain words: what you set up, what is waiting for the user's confirmation, and the suggested next step (normally tailoring a resume for the saved Job). Do not claim a Profile change unless a readback shows it. Leave out internal terms such as Run, working note or candidate status.

When a step depends on current employer, hiring or market reality, refresh it through an available authorized source and keep exact URLs and retrieval dates. Never put private Profile or resume text into public searches.
