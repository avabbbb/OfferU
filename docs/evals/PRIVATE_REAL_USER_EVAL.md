# OfferU Private Real-User Eval

This suite evaluates OfferU with frozen real-user Career data without modifying the live workspace or committing private data.

## Data boundary

```text
live OfferU SQLite (read-only source)
  -> SQLite online backup
  -> raw Private Seed outside the repository
  -> conservative curated copy
  -> per-case clone
  -> Agent trial
  -> deterministic outcome + trace grading
```

- The live database is never a trial database.
- Raw and curated seeds, resumes, job descriptions, conversations, labels and ratings stay under a repo-external private workspace.
- API keys, cookies, OAuth tokens and passwords never belong in Eval datasets or artifacts.
- Curation preserves the raw snapshot and removes only explicit demo/fixture candidates without protected references. Referenced candidates remain for human review.

The design follows the same principles described by [Anthropic's agent eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): clean independent trials, objective outcome graders, repeated trials and trajectory review. Live sources are reported separately because changing external state is not a reproducible benchmark.

## Bootstrap

Run from `backend/` with the project Python environment:

```powershell
python scripts/live_eval/runner.py `
  --private-seed-create `
  --source-db .\djm.db `
  --private-workspace H:\tmp\offeru\private-eval
```

The command creates:

- a raw online-backup seed and count/hash-only manifest;
- `ground_truth.template.json`;
- `skill_route_50.template.json`;
- `private_real_user_20.template.json`;
- `human_ratings.template.json`.

Curate a raw snapshot without changing it:

```powershell
python scripts/live_eval/runner.py `
  --private-seed-curate `
  --source-db H:\tmp\offeru\private-eval\seeds\<seed>\private_seed.db
```

Extract secret-redacted natural-language candidates from historical Agent Run goals:

```powershell
python scripts/live_eval/runner.py `
  --private-prompt-extract `
  --source-db H:\tmp\offeru\private-eval\seeds\<seed>\curated\private_seed_curated.db `
  --private-workspace H:\tmp\offeru\private-eval
```

## Readiness gate

```powershell
python scripts/live_eval/runner.py `
  --private-workspace-check `
  --source-db H:\tmp\offeru\private-eval\seeds\<seed>\curated\private_seed_curated.db `
  --private-workspace H:\tmp\offeru\private-eval
```

The gate fails closed until all conditions hold:

- 50 unique natural-language SkillRoute prompts have capability labels;
- 20 real-user cases have user turns and deterministic outcome criteria;
- Job, Resume, Application and preference Ground Truth exists;
- no credential-like value appears in the private labels;
- SQLite integrity and foreign keys pass.

`NEEDS_USER_INPUT` is not a baseline. Only `READY_FOR_PRIVATE_EVAL` permits a formal run.

## SkillRoute-50

Run the completed repo-external dataset against progressive discovery:

```powershell
python scripts/live_eval/runner.py `
  --skill-route-file H:\tmp\offeru\private-eval\skill_route_50.json `
  --source-db <curated-seed> `
  --discovery-mode progressive `
  --repeat 3
```

Repeat with the same Runtime, model, seed and prompts using `--discovery-mode full-registry`. This is an Eval-only ablation and does not change production defaults.

`metrics.json` records routing accuracy when human labels exist, recovery, Skill expansions, schema loads, Operation calls, full-registry fallback, pass@1, pass^k, provider failures, hard gates, average latency and p95 latency.

## Private Real-User 20

```powershell
python scripts/live_eval/runner.py `
  --private-suite-file H:\tmp\offeru\private-eval\private_real_user_20.json `
  --source-db <curated-seed> `
  --mode real-user `
  --repeat 3
```

Cases remain ordinary `EvalCase` values after loading. They therefore reuse the existing SQLite clone, DB diff, Operation audit, trace, provider taxonomy, Proposal boundary and Safety Hard Gates.

## Human grading

Subjective outputs use the private `human_ratings.template.json` fields:

- `useful`: 1–5;
- `grounded`: 1–5;
- `would_use`: yes/no.

Human ratings complement deterministic outcome grading; they never override a Safety Hard Gate.

## Live Shadow

Run a read-only Live Shadow trial only after the reproducible private suite is frozen. It may read current OfferU, BOSS or email state when a safe connector exists, but it must not submit applications, send messages or perform any irreversible external action. `LIVE_SHADOW` observations are reported separately and never included in benchmark scores.

## Verdict

Use exactly one status:

- `PRIVATE_EVAL_BASELINE_ESTABLISHED` after a frozen 3-trial run, trace review and required human ratings;
- `PRIVATE_EVAL_BASELINE_NOT_ESTABLISHED` with explicit missing labels, data, provider or review evidence.
