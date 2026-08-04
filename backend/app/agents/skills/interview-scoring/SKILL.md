---
name: interview-scoring
description: Score mock-interview answer content with a versioned declarative rubric, persist reproducible evidence, and report locally derived delivery events separately. Use for AI interview evaluation, custom interview rubrics, answer feedback, and body-language event summaries.
---

# Interview Scoring Skill

Use the rubric in `references/default-rubric.json` unless the interview pins another validated version.

## Workflow

1. Resolve the pinned `skill_id` and `version`.
2. Evaluate answer content only from the question, answer, verified career evidence, and job dossier.
3. Require answer excerpts for every scored dimension.
4. Compute the weighted content score deterministically; never accept a model-provided total.
5. Keep delivery events in a separate summary of counts, duration, confidence, and detector version.
6. Persist the rubric version, input hash, model runtime, content result, and delivery summary.
7. Emit a learning observation; never write interview feedback directly into Profile.

## Custom Rubric Guide

Default rubric: `references/default-rubric.json`. Customize only when the pinned skill does not fit the target role or goal.

### Draft a rubric (no write)

Run the `draft_interview_scoring_skill` operation through the Operation Registry:

- `goal` (required): what the rubric should score.
- `target_role` (optional): role label to scope the dimensions.
- `job_id` (optional): injects the role dossier's `interview_process` / `interview_question` / `role_requirement` findings as dimension-design input when that job was researched.

The operation returns a **draft only** — it never persists. The draft must pass `validate_scoring_skill_definition` (retried once with the error); a second failure raises and returns no draft.

### Promote the draft (HITL)

Only after explicit user confirmation, call `create_interview_scoring_skill` with `skill_id`, `name`, `definition=<draft>`, and `user_confirmed=true`.

### Draft constraints

- Dimensions are weighted within the schema; aggregation is `weighted_mean`; every scored dimension requires answer excerpts.
- `score_bands`: 2–8 bands, `min` descending, and a `min=0` fallback band is mandatory.
- `behavior_display` is the only optional top-level key and is display-only: it selects which delivery-behavior panels the report renders and never feeds the content score.
- Prohibited outputs and delivery-term red lines still apply to the draft.

## Boundaries

- Do not execute Python, JavaScript, Shell, plugins, or undeclared dependencies from a rubric.
- Do not combine content and delivery into one score.
- Do not infer personality, emotion, honesty, health, protected traits, job fitness, hiring probability, or cultural fit from camera, gesture, posture, face, or voice signals.
- Do not store raw audio, video, screenshots, frames, landmarks, or face embeddings.
- Do not invent scores or return success after invalid model output.
- Use the Operation Registry for every read or write.
