# Branch and Test Baseline Guard

Status: **CURRENT ENGINEERING POLICY**  
Date: 2026-10-06

OfferU uses parallel Agents and Git worktrees heavily. The failure mode this policy prevents is simple:

> development continues across several long-lived branches, while owner testing or packaging happens from an old branch that no longer contains current `origin/main`.

A test can be technically green and still be useless if it tested the wrong source identity.

## One shared integration baseline

At any time keep at most three local **named branches**:

1. `main`;
2. current primary development branch;
3. current integration branch.

Parallel child workers do not get permanent named branches. They use detached worktrees created at an exact, recorded integration SHA:

~~~powershell
git fetch origin main
python backend/scripts/dev/branch_guard.py --mode start
git worktree add --detach H:\tmp\offeru\workers\<task> <integration-sha>
~~~

A detached worker may commit normally. It returns its commit SHA to the coordinator; the coordinator reviews/cherry-picks or otherwise integrates that exact commit into the single integration branch.

Do not create `luna-1`, `luna-2`, `review-x`, `fix-y` named branches merely to obtain filesystem isolation.

Git worktree isolation and Git branch identity are separate concerns.

## Required guard commands

### Before starting a new development batch

~~~powershell
python backend/scripts/dev/branch_guard.py --mode start
~~~

This refreshes `origin/main`, rejects a stale baseline and rejects more than three local named branches.

A dirty start is reported but may continue because active development can legitimately contain work in progress. Such a run cannot later be reported as clean owner acceptance.

### Before integrating a worker batch

~~~powershell
python backend/scripts/dev/branch_guard.py --mode integrate
~~~

Integration requires:

- current HEAD contains latest `origin/main`;
- committed/clean source identity;
- local named branch budget <= 3.

If main advanced during a long parallel batch, refresh the integration branch first, resolve conflicts once at the coordinator, then rerun direct dependency checks.

### Before owner / real-user testing

~~~powershell
python backend/scripts/dev/branch_guard.py --mode owner-test
~~~

Owner testing fails when:

- HEAD is behind current `origin/main`;
- the worktree is dirty;
- more than three local named branches exist.

The command prints:

- branch;
- exact HEAD;
- exact `origin/main`;
- ahead/behind counts;
- dirty state;
- named branch count;
- worktree count.

This output belongs in the acceptance report.

### Verify the running app is the source you intended to test

After the backend/Desktop is running:

~~~powershell
python backend/scripts/dev/branch_guard.py --mode owner-test --runtime-health-url http://127.0.0.1:8766/api/health
~~~

The guard additionally requires `/api/health.build_identity.commit == git HEAD`.

This catches a second common failure mode:

> source checkout is current, but the user is actually testing an old sidecar/EXE/DMG.

If the running build does not identify the same commit, stop the acceptance run and rebuild/relaunch. Do not reinterpret results from the old runtime as evidence for current source.

## What “current” means

A feature/integration branch may be ahead of main. That is fine.

For current owner testing:

~~~text
origin/main must be an ancestor of HEAD
AND source worktree must be clean
AND running build commit must equal HEAD when runtime checking is requested
~~~

The branch does **not** need to equal main; it needs to include latest main plus the candidate changes being tested.

Historical reproduction may intentionally use an old commit, but it must be labelled historical reproduction and must not use `owner-test` evidence language.

## Parallel worker lifecycle

Use this lifecycle:

~~~text
latest origin/main
      ↓
primary dev / integration branch
      ↓ exact SHA
detached worker A
detached worker B
detached worker C
      ↓ commits returned early
single integration branch
      ↓ refresh current origin/main
integration checks
      ↓
owner-test guard
      ↓
runtime identity check
      ↓
real owner acceptance
~~~

Workers should be short-lived. Once their commit is reviewed and integrated, remove the detached worktree when safe. A child worker must not silently become a new long-lived integration authority.

## PR freshness

`.github/workflows/branch-freshness.yml` checks every PR to `main` from the PR's real head SHA and fetches the current base branch.

The check fails when the PR head does not contain current main.

This complements GitHub's native branch-protection option “require branches to be up to date before merging”. Repository protection/ruleset configuration is still the final server-side hard gate; the workflow makes stale state visible even before that setting is enabled.

## No evidence without identity

Every real acceptance report must record:

- source branch or detached state;
- HEAD SHA;
- current `origin/main` SHA;
- ahead/behind;
- dirty flag;
- runtime/build commit when testing Desktop/package;
- whether the guard passed.

“Tests passed”, “EXE opens”, “Agent works” or screenshots without source/build identity are not current-version acceptance evidence.

## Relationship to existing branch archive

The 2026-10-05 consolidation remains valid historical recovery evidence in [branch-consolidation-20261005.md](./branch-consolidation-20261005.md).

This policy changes the forward workflow: do not allow another 29-branch accumulation and then clean it up after the fact. Prevent branch growth and stale testing before work starts.
