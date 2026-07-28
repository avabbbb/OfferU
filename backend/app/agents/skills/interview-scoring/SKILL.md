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

## Boundaries

- Do not execute Python, JavaScript, Shell, plugins, or undeclared dependencies from a rubric.
- Do not combine content and delivery into one score.
- Do not infer personality, emotion, honesty, health, protected traits, job fitness, hiring probability, or cultural fit from camera, gesture, posture, face, or voice signals.
- Do not store raw audio, video, screenshots, frames, landmarks, or face embeddings.
- Do not invent scores or return success after invalid model output.
- Use the Operation Registry for every read or write.
