# Zero-Setup Beta implementation record — 2026-09-23

Status: onboarding and native packaging code implemented; runtime acceptance pending. No builds, tests, runtime probes, browser checks, or release publication have been executed in this task, per the project's development instructions. This is not a public-release acceptance report.

## Scope and decisions

The current checkout is newer than the `7fee782` snapshot in the request. Reuse the existing Operation Registry, evidence gates, application progress inbox, AI discovery, and desktop shell. Do not add another AI loop or a second set of career business operations. The companion window can guide setup without changing the accepted external-Harness ownership model.

Memory and email are optional steps. Skipping a step does not mark it complete. Business readiness comes from current API data, not local onboarding flags. One primary action is visible in each step.

## Implemented slice: first-use path

| User outcome | Implementation | Acceptance still required |
| --- | --- | --- |
| Resume setup after closing/reopening | `useOnboarding.ts` stores only wizard position/completion; checklist and wizard share `useSetupProgress.ts` | Reload, cross-tab changes, unavailable storage |
| Find an installed AI | Existing discovery and connection provider, now correctly above the onboarding gate | Fresh connection, missing login, unavailable provider |
| Resume → reviewed profile | Keyless local PDF/DOCX extraction; display canonical fields; existing evidence-backed confirmation; preserve partial success on retry | Actual files, extraction failure, interrupted confirmation |
| Selected AI memory → review inbox | Explicit consent, selected excerpts only, idempotent observations/proposals, all imported AI claims remain hypotheses | Retry, background consolidation, reject/accept, no unconfirmed profile writes |
| Discover a Codex memory summary | Metadata-only discovery of `$CODEX_HOME/memories/memory_summary.md` (default `~/.codex`); a separate explicit read consent previews at most 80 KB | Missing files, consent, links, oversize files, Agent self-authorization denied |
| Save first job | Existing job modal with live preparation in guided mode; detect extension saves from the existing jobs API | Current-page capture and manual paste, ingestion failure visibility |
| Connect email → review progress | Shared QQ/163/126/Gmail/Outlook connection form, app-code help, read-only consent, existing sync/candidate operations | Real provider credentials, partial sync failure, human review |
| Return to Today | Same live status projection; unfinished steps remain available | Genuine end-to-end timing with a new user |

Backend simplification removes duplicate profile serializers/loaders/normalizers from the route layer and repeated email Registry result handling. Memory consolidation now uses the canonical profile category validator, including stable custom categories. The Gmail OAuth return route uses the application's hash router while preserving the existing authorization query handling.

The old personality questionnaire and automatic resume-generation path were removed from the first-use wizard. Existing career/profile operations remain the data authority.

## Implemented slice: native desktop distribution

- `backend/scripts/build_sidecar.mjs` is the common native Windows x64 / macOS Intel / macOS Apple Silicon builder. The PowerShell entry delegates to it. It bundles Python, the existing minimum AI runtime, Node, and the generated OfferU Skill; checks architecture consistency; and preserves the dependency lock file while pruning the optional Claude SDK. No cross-compiled or universal Mac package is claimed.
- `frontend/src-tauri/tauri.conf.json`, `tauri.macos.conf.json`, `Entitlements.plist`, and `src/lib.rs` locate both executable sidecars next to the desktop executable. This fixes the previous macOS Resources/MacOS mismatch and the hard-coded Windows Node filename. Minimum macOS configuration is 13.5, matching bundled Node 24's documented minimum, not a tested support verdict.
- `backend/sidecar_entry.py` supports a bundled `cli` mode. The installed OfferU Skill uses this entry with the persistent data directory explicitly supplied; it no longer points at a source checkout or treats a frozen executable as a Python interpreter.
- `.github/workflows/macos-package.yml` adds native DMG jobs for Intel and Apple Silicon. Release tags require Apple signing credentials, signature verification and notarization; non-release artifacts are not marked signed. The build workflow includes these jobs before creating a draft release.
- Windows and macOS share `collect_release_artifacts.py` and `verify_release_artifacts.py`. Outputs are `OfferU-Setup-x.y.z.exe`, `OfferU-x.y.z-x64.msi`, `OfferU-x.y.z-arm64.dmg`, and `OfferU-x.y.z-x64.dmg`, with checksum and platform/version verification.
- `smoke_macos_package.py` copies the app to an isolated directory and exercises the bundled CLI, Node, and backend with development tools removed from PATH. It does not open a UI, claim Agent acceptance, or replace clean-machine user acceptance. It has not been run in this task.

## Incomplete product gates

- Native discovery currently covers only the known Codex summary-file layout. WorkBuddy and Claude native memory adapters remain unimplemented; users can choose exports. The reader does not scan sessions or read authentication files. Development did not execute the new reader against real user memory.
- No Chrome/Edge store listing exists in the implementation. The wizard states this and provides manual JD capture; it does not claim one-click extension installation.
- EXE/DMG signing, clean-machine installation, installed runtime health, browser compatibility, and a timed ten-minute user journey remain unverified.
- Real mailbox authorization and real human confirmation were not automated.
- Natural-language manual progress such as “我进二面了” and live-site Smart Fill were not separately accepted in this task.

## Suggested checks, not executed

Run from `backend/`, using an isolated test environment under `H:\tmp\offeru`:

```powershell
python -m pytest tests/test_memory_import.py tests/test_email_routes.py tests/test_career_memory.py tests/test_profile_agent_memory_gate.py -q
python -m pytest tests/test_local_memory.py -q
python -m pytest tests/test_agent_integration.py tests/test_runtime_paths.py tests/test_tauri_security_contract.py tests/test_release_artifact_manifest.py -q
```

Run from `frontend/`:

```powershell
npm run test -- src/components/jobs/AddJobModal.test.tsx src/components/onboarding/ResumeSetup.test.tsx src/components/onboarding/MemorySetup.test.tsx
npm run typecheck
npm run build
npm run tauri -- build --bundles nsis,msi
```

Browser acceptance, when explicitly requested, must use managed Chromium, headless mode, `http://127.0.0.1:7410`, and an isolated profile under `H:\tmp\offeru`. Backend port remains 8766.

For Mac packaging, use the native GitHub Actions jobs or `npm run tauri -- build --bundles app,dmg` on a native Mac with development prerequisites. End users consume the bundled app. No build or workflow was launched here. Apple/Windows signing secrets and store accounts were neither inspected nor changed.

## Change map

- Onboarding UI: `frontend/src/components/onboarding/` and `frontend/src/lib/useOnboarding.ts`.
- Shared UI/API integration: `frontend/src/lib/api.ts`, `hooks.ts`, `app/providers.tsx`, `app/page.tsx`, `app/email/page.tsx`, `components/workbench/WorkbenchShell.tsx`, `components/jobs/AddJobModal.tsx`.
- Backend changes: profile/email route deduplication; memory import route, service, Registry registration, canonical consolidation validator, and `local_memory.py` for consented Codex summary previews. Previews are classified as external data access so an Agent cannot grant itself permission through a CLI boolean. Preview text and imported content are excluded from the Operation audit payload.
- Packaging changes: files listed in the native distribution section, the common build workflow, and corresponding contract tests. Existing unrelated security/concurrency edits within shared files are preserved and are not attributed to this task.
- Regression coverage added, not executed: separate memory read/save/accept actions, Agent self-authorization denial, memory retry/consolidation, OAuth hash routing/errors, resume field review and partial-save retry, guided job ingestion mode, frozen CLI and platform-specific release metadata.

## Workspace preservation

Unrelated modifications are present across backend security, runtime, application progress, packaging configuration, and other modules. They were not reverted. A full working-tree diff is not a reliable attribution of this task's edits; only the files and changes described here belong to this implementation record.

## References checked

- [WorkDaddy packaging](https://github.com/babygoton/WorkDaddy/blob/main/README_en.md)
- [career-ops prerequisites](https://career-ops.org/docs)
- [Manual current-page capture](https://chromewebstore.google.com/detail/career-ops-capture/emnnnnjlecidladmnnjopelhipkomnaa)
- [Gmail app passwords and account limitations](https://support.google.com/mail/answer/185833?hl=zh-Hans)
- [Tauri sidecar contract](https://v2.tauri.app/develop/sidecar/)
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
- [GitHub native Mac runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Node 24 platform minimums](https://github.com/nodejs/node/blob/v24.x/BUILDING.md)
