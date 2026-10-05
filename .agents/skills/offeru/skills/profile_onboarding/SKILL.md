---
name: offeru-profile-onboarding-method
description: Evidence-led method for discovering and initializing the canonical OfferU Profile.
method_version: 1.0.0
---

# Profile onboarding method

Use this method while the active OfferU Skill is `profile_onboarding`. It is shared guidance for whichever single Agent is reasoning in this Run. It does not create another profile, memory store, or write path.

## Inputs

- The user's current goal and any explicit boundaries they gave.
- The canonical Profile from `get_profile`, its evidence from `list_profile_evidence`, and pending learning from `list_learning_observations` / `list_memory_inbox` when those Operations are available in the live Skill.
- A resume only after the user selects or supplies it; use `inspect_resume_document` to inspect that selected document. Preserve its identity and source reference.
- Agent memory or local work material only when the user has explicitly selected and authorized that source and scope. A host memory excerpt is a lead, not verified Career Evidence.

Read the selected Skill's live manifest and each Operation schema first. Do not infer access from this method file. Do not scan folders, conversations, credentials, or neighboring job records to fill a missing input.

## Method

1. Decide whether this is first-time Profile discovery or a focused gap check. Read the existing canonical Profile and evidence first; do not repeat facts already available or run a full survey when the user has a narrower goal.
2. Build a temporary evidence map across target roles, search stage, education, employment, projects, ownership, outcomes, skills-in-use, preferences, constraints, and unresolved conflicts. For each claim record its exact OfferU or user-selected source reference and classify it as `strong`, `weak`, `missing`, `unknown`, or `under-expressed`. This map is a Run working note, not a new persisted Profile schema.
3. For a selected resume, distinguish what the document literally supports from what needs the user's account. Ask about a concrete gap: what the user did, their own contribution, the result, and where that result can be checked. Do not pressure the user to estimate a number; keep an unavailable result unknown or qualitative.
4. Ask one focused question only when the answer would materially change Profile direction or resolve a consequential ambiguity. Do not ask for information already readable in authorized canonical context. An answer supplies context or a preference; it is not approval to write or adopt a fact.
5. Compare new statements with existing Profile evidence. Keep contradictions visible with both source references. Do not strengthen responsibility, ownership, dates, metrics, technologies, or outcomes beyond the cited evidence. Treat imported memory and third-party Skill analysis as observations/candidates until the applicable evidence and review steps complete.
6. Use only Operations exposed by the live `profile_onboarding` Skill. Submit a memory or fact change only through its current schema and permission route. Leave review/adoption Operations to the independent OfferU user surface; never treat an Ask answer as that review.

## Result and visibility

Report a compact result with: discovery scope; confirmed evidence and its references; weak, missing, unknown, or under-expressed areas; conflicts; questions still open; and each created candidate/proposal with its actual status. A durable result must appear in the existing Profile, Learning Observation, or Memory Inbox surface through OfferU. If only a working note exists, say that no persistent result was created. Do not claim a Profile fact changed unless the Operation readback confirms the change and the applicable review is complete.

When a next step depends on current employer, role, hiring, compensation, or market reality, refresh that external information through an available authorized source and retain exact URLs and retrieval dates. Do not include private Profile or resume text in public searches. If the source is unavailable, mark the affected conclusion partial and name the missing evidence.

