# Contract fixtures

The expected outputs here (`*.json`, `resume/golden.json`, `data/python-store.json`, ...) were generated from the
Python backend, which has since been removed. The `gen_*.py` scripts only run against the last Python version:

```bash
git worktree add /tmp/offeru-py python-backend-final
cd /tmp/offeru-py/backend && python ../backend-ts/test/fixtures/<script>.py
```

They are now the baseline for the TypeScript behaviour. When a change is intentional, edit the fixture directly and
say so in the PR.
