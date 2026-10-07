> **已归档（2026-10）**：本文不再是当前权威。当前文档：历史证据，见 09-quality-and-release.md（位于 `docs/`）。

# Unified Agent access: source audit and implementation plan

Baseline: `e1dbbaf`; integration branch `feat/agent-contract-desktop-binding`. User instructions on 2026-09-30 supersede the copy-a-connection-prompt default and preserve a useful built-in Agent. This report records current evidence, not a claim of universal compatibility.

## Real source conflicts

Merged [PR #43](https://github.com/avabbbb/OfferU/pull/43), commit `72c412c92d5591c9060ab71a331e0fb0e045dba8`, made public Skills installed-product bootstraps. Current `agent_skill_projections.py` again emits `Work from backend/`, source Python commands, manual directory installation and localhost projection fetching. `agent_integration._installed_content()` still substitutes `<offeru-cli>` and a runtime-binding marker that no longer exist in that template. Consequently an installed Desktop projection can retain source-only instructions. Existing projection equality checks cannot detect a generator and its output regressing together.

GOAL, AGENTS and current-product also reintroduced the copy/paste default. Existing Desktop connection APIs already support discovery, install/update and actual Codex nonce readback; frontend currently offers only copy text. Reuse those APIs rather than inventing another pairing state store. AgentRunProvider/Pi, external Bridge, Skill allowlists, Operation projection, UI-only confirmation and canonical CareerTask already exist. CareerTask→AgentRun binding and resume editor safety defects from the full review remain separate necessary fixes.

## Host capability matrix (2026-09-30)

| Host | Public capability source | OfferU implementation evidence / gap |
|---|---|---|
| Codex | [MCP](https://developers.openai.com/codex/mcp), [Skills](https://developers.openai.com/plugins/concepts/skills) | Existing install adapter, app-server/Bridge, nonce + model-issued Operation verification; packaged live acceptance must be rerun |
| Claude Code | [MCP](https://code.claude.com/docs/en/mcp) | Skill installation and hosted runtime exist; installation does not prove live readback |
| WorkBuddy | [official connectors](https://open.workbuddy.cn/docs/connector) | Existing CodeBuddy hosted runtime; WorkBuddy consumer connector and CodeBuddy CLI are distinct surfaces, not interchangeable proof |
| OpenCode | [MCP](https://opencode.ai/docs/mcp-servers/) | Skill install/discovery exists; discovery alone is not VERIFIED; web research declared limited |
| OMP | [upstream Skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md), [config/MCP](https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md) | Hosted executor exists; no current Desktop Skill-install adapter; cannot claim parity |
| ChatGPT | [official MCP requirements](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) | Remote MCP/App and account/mode restrictions; no direct ordinary localhost; OfferU remote auth/transport not implemented |
| Claude consumer | [remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | Remote MCP exists; OfferU connector not implemented; Desktop local extension is a separate capability |
| Muse | [September 29 announcement](https://about.fb.com/news/2026/09/introducing-muse-small-business/) | Official custom connectors announced; auth/tool acceptance and working OfferU connector remain unverified |
| Grok consumer | [custom MCP](https://docs.x.ai/grok/connectors/custom-mcp-tunneling) | Official remote reachability requirement; no OfferU remote connector; xAI API MCP is not consumer integration evidence |
| dots | [official getting started](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) | Official docs confirm connected apps and opt-in local computer tasks/skills; arbitrary third-party connector parity and OfferU integration remain unverified |

Research used official vendor or upstream sources. Availability is not compatibility. No remote endpoint or tunnel has been activated.

## Scope and commit slices

1. Restore installed-product Skill binding, define the host-neutral contract, align authority documents and add semantic regression checks. Keep built-in canonical operations and evidence-backed resume assistance.
2. Wire existing Desktop discovery/install/probe APIs into the ordinary Agent entry. Show actual detected/installed/verified/failure states; preserve users' native credentials and proxy. Do not make Agent setup a gate before Profile/Job value.
3. Reuse the mounted context rail/bottom interaction to bind Job/Resume/Interview/Today and project canonical runs/artifacts/proposals; do not pretend to embed unsupported native consumer chat. Repair CareerTask binding with bounded Director execution.
4. Add official remote transport/auth adapters only after scoped local contract acceptance. Never publish port 8766 or grant all Registry reads by default. External Agent provides reasoning/execution; Runtime owns event scheduling, leases/recovery/dedupe and durable outcomes.
5. Real Codex dogfood: Career Truth/curated Memory reads → role assessment → evidence-backed resume proposals → Today/Job Workspace/Resume/HITL visible results. Reads and prepared artifacts are distinct from adopted Career Truth. Human approval must remain independent.

## Acceptance layers

Source/projection checks; frozen command binding and API contracts; isolated persistence/permission tests; frontend type/tests/build; managed Chromium headless mounted UI; real model-issued Codex calls and auditable Run/Operation/artifact evidence; independent user approval where required. Fixture/replay passes never substitute for live Agent or human permission evidence. Temporary evidence stays under `H:/tmp/offeru/agent-contract-20260930/`. Status will be updated after implementation and actual checks.

## Implemented slice and measured evidence

Public generator/projections, GOAL/current-product/onboarding authority and shared CLI/MCP contract metadata are aligned. Frozen Skill binding fails closed when its marker is missing; manifest commands use the running executable and data directory. Desktop connection UI reuses discovery/install/update/probe APIs and requires actual verified readback plus ready provider state; normal browser and Showcase cannot install hosts. Native credentials, model selection and proxy are preserved. Built-in governed operations/resume assistance remain available.

The clean staged checkout passed **100 backend tests + 9 subtests**, including **15 control-plane/tool-surface tests**, with the known global architecture assertion deselected. An earlier run including that assertion failed solely on the pre-existing `backend/app/routes/optimize.py::optimize_agent_chat_stream` Registry bypass. This finding is not waived or fixed by the integration. Frontend typecheck, 9 connection/context tests and production build passed.

An actual PyInstaller executable ran its manifest and `get_current_view` from a different directory against isolated SQLite state. The reproducible bootstrap (`backend/scripts/e2e/test_agent_contract_bootstrap.py`) called the real ASGI UI context API, persisted a synthetic page selection, discovered a project Skill in native Codex and obtained **model-issued** `get_current_view` through the frozen CLI. Native Codex `0.159.2`, configured model `gpt-5.6-luna`, thread `01a0f275-2f67-7ad0-b61a-afc8f829f53f`, turn `01a0f275-2fb1-70c0-aa00-2bb16afec374` returned fixture entity `9001`. Native auth files were neither copied nor edited. The Skill fixture uses the real frozen manifest command; it is not native Desktop installation acceptance, and entity `9001` is a synthetic UI selection, not a populated Job.

Mounted managed Chromium/headless UI checks passed for the ordinary browser guard and a clearly labelled **Desktop preview with fixture API responses** (`frontend/scripts/test-agent-connection-ui.cjs`). The preview exercised discovery and the existing connection API request; its verified badge is a fixture, independently distinguished from the live Codex evidence. Screenshots and JSON results are in `repro-ui/`; live results/events are in `clean-bootstrap2/`. Canonical audit rows record the UI context update and successful CLI read. One bootstrap repetition failed its callback assertion; tightening the harness's explicit dynamic-tool instruction and preserving failure events produced the passing clean-checkout run. This is not yet a repeated-run reliability gate. No Career Truth or real host Skill was mutated by the UI test.

Native frozen API serving could not be isolated because port 8766 was occupied; the existing service was retained. Native Tauri installer, real host-global Skill install/update, independent human approval, full CareerTask/Run recovery and the multi-Job/resume dogfood scenario remain **not accepted**. Consumer remote connectors remain unimplemented. The Main Agent route still defaults to Pi; verified Codex connection does not yet switch bottom-chat reasoning to Codex.

Prerequisite [Draft PR #46](https://github.com/avabbbb/OfferU/pull/46) delivers two resume design modules already imported by main, with 5 backend and 1 frontend focused tests passing. Without these files, a clean checkout cannot import/build. Other existing resume/review artifacts are retained outside this slice. Concurrent connection persistence/readback hardening edits observed during validation are preserved but excluded from this PR pending ownership clarification; validation of the isolated staged checkout avoids silently incorporating them.

Reproduce the local tests from the source development environment (these are developer acceptance commands, not ordinary-user Skill instructions):

```powershell
# backend; use an isolated H:/tmp/offeru data directory
.venv312/Scripts/python.exe scripts/e2e/test_agent_contract_bootstrap.py --sidecar H:/tmp/offeru/agent-contract-20260930/frozen/offeru-contract.exe --evidence-dir H:/tmp/offeru/agent-contract-repeat
# frontend; ready local UI, managed Chromium installed in this H: cache
$env:PLAYWRIGHT_BROWSERS_PATH = 'H:/tmp/offeru/ms-playwright'
node scripts/test-agent-connection-ui.cjs
```
