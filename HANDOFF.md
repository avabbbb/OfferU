# OfferU Handoff

Updated: 2026-09-17

## Current state

- Public Release: `OFFERU_PUBLIC_RELEASE_NOT_READY`
- Internal Beta: largely met; Resume Workspace is `RESUME_WORKSPACE_BETA_READY`
- Backend: `backend/.venv312/Scripts/python.exe run_server.py` → `http://127.0.0.1:8766`
- Frontend: `npm run dev` in `frontend/` → `http://127.0.0.1:7410`
- Test workspace: `H:\tmp\offeru` only

## Immediate next actions

1. Finish Security/Privacy residuals (3 legacy email bodies, artifact/PII scrub, retention policy)
2. Release engineering: signed installer, previous-release upgrade, clean-machine smoke
3. Live Role Intelligence: configure a real provider and run the 10-role matrix
4. BOSS Connector: requires live credentials and user supervision — do not run unattended

## What not to do

- Do not create another eval framework, quality score, or release checklist
- Do not split `ops.py` or migrate NextUI → HeroUI
- Do not run parallel `web_search` calls (OMP bug #8865)
- Do not navigate to `8080` — it is not a web entry point

## Where things live

- Current state: `STATUS.md` (concise dashboard)
- History: `docs/archive/STATUS-history-2026-09.md`
- Architecture: `CONTEXT.md`, `ARCHITECTURE.md`, `docs/adr/`
- Constraints: `AGENTS.md`
