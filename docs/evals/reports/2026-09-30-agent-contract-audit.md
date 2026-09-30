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
| WorkBuddy | [official connectors](https://open.workbuddy.cn/en/docs/connector) | Official indexed documentation describes MCP+Skill or CLI+Skill (one approach per connector). Direct page retrieval was unavailable in this audit. Existing CodeBuddy hosted runtime is a distinct surface; no WorkBuddy connector acceptance |
| OpenCode | [MCP](https://opencode.ai/docs/mcp-servers/) | Skill install/discovery exists; discovery alone is not VERIFIED; web research declared limited |
| OMP | [upstream Skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md), [config/MCP](https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md) | Hosted executor exists; no current Desktop Skill-install adapter; cannot claim parity |
| ChatGPT | [official MCP requirements](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) | Remote MCP/App and account/mode restrictions; no direct ordinary localhost; OfferU remote auth/transport not implemented |
| Claude consumer | [remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | Remote MCP exists; OfferU connector not implemented; Desktop local extension is a separate capability |
| Muse | [September 29 announcement](https://about.fb.com/news/2026/09/introducing-muse-small-business/) | Official custom connectors announced; auth/tool acceptance and working OfferU connector remain unverified |
| Grok consumer | [custom MCP](https://docs.x.ai/grok/connectors/custom-mcp-tunneling) | Official remote reachability requirement; no OfferU remote connector; xAI API MCP is not consumer integration evidence |
| dots | [official computers/apps](https://learn.chatgpt.com/docs/dots/computers-and-apps) | Official docs confirm installed/enabled plugins and local Skills through an explicitly connected computer. No OfferU plugin acceptance; account availability and local/cloud environment permissions require separate verification |

Research used official vendor or upstream sources. Availability is not compatibility. No remote endpoint or tunnel has been activated.

Additional source verification: [Codex local stdio/HTTP MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [ChatGPT plugin testing](https://developers.openai.com/plugins/deploy/connect-chatgpt), [Muse connector documentation](https://www.meta.com/help/artificial-intelligence/1687253048996149/), and [OMP upstream configuration](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/config-usage.md). Consumer ChatGPT plugins, local Codex MCP and dots local computer grants are distinct surfaces.

## Further live-code conflicts

- `AgentPanel.sendMessage` omits the provider; `PiAgentRunRequest` defaults to Pi; `get_agent_run_provider` accepts only Pi/replay. Desktop readback is not proof that panel career work uses Codex.
- `automation.py` rewrites explicit Codex/auto provider choices to Pi for multiple Director triggers. `career_tasks.py` must bind the canonical task/Run before external execution; no parallel Director loop should repair this.
- MCP formerly listed the whole Registry by default. This slice aligns compact discovery with CLI and denies internal operations from MCP schema/invocation. It remains local transport, not an authenticated remote connector.
- `optimize_agent_chat_stream` bypasses the Registry. Architecture/control-plane gates fail on main for this route; this audit does not weaken or exempt those checks.
- Main imports missing `resume_design` modules. Local prerequisite commit `f6a45a9` supplies those already-required files. The PR preserves this prerequisite without expanding resume functionality.

## Scope and commit slices

1. Restore installed-product Skill binding, define the host-neutral contract, align authority documents and add semantic regression checks. Keep built-in canonical operations and evidence-backed resume assistance.
2. Wire existing Desktop discovery/install/probe APIs into the ordinary Agent entry. Show actual detected/installed/verified/failure states; preserve users' native credentials and proxy. Do not make Agent setup a gate before Profile/Job value.
3. Reuse the mounted context rail/bottom interaction to bind Job/Resume/Interview/Today and project canonical runs/artifacts/proposals; do not pretend to embed unsupported native consumer chat. Repair CareerTask binding with bounded Director execution.
4. Add official remote transport/auth adapters only after scoped local contract acceptance. Never publish port 8766 or grant all Registry reads by default. External Agent provides reasoning/execution; Runtime owns event scheduling, leases/recovery/dedupe and durable outcomes.
5. Real Codex dogfood: Career Truth/curated Memory reads → role assessment → evidence-backed resume proposals → Today/Job Workspace/Resume/HITL visible results. Reads and prepared artifacts are distinct from adopted Career Truth. Human approval must remain independent.

## Acceptance layers

Source/projection checks; frozen command binding and API contracts; isolated persistence/permission tests; frontend type/tests/build; managed Chromium headless mounted UI; real model-issued Codex calls and auditable Run/Operation/artifact evidence; independent user approval where required. Fixture/replay passes never substitute for live Agent or human permission evidence.

## Slice 1 evidence and limits

- Implemented: one CLI/MCP contract snapshot and compact Skill-scoped discovery, generated installed-product projections, fail-closed executable binding, semantic drift checks, and model-issued readback validation (a self-reported nonce cannot pass).
- Verified: `test_agent_skill_projections`, `test_agent_integration`, `test_cli_ops`, `test_codex_adapter_process_failure`: 66 passed / 4 subtests. Projection generation check passes.
- Verified: Windows onefile executable built from this checkout, invoked outside the source tree; installed Skill content comes from its `cli skill` command. Real native Codex discovered that Skill and called `get_current_view` through the executable, reading fixture job `9001` after isolated API context synchronization. Actual native response attributed model `gpt-5.6-luna`, thread `01a0f27b-d6f8-7401-946c-73f7ab10223e`, turn `01a0f27b-dcb0-74e0-9f6d-3540481619f8`.
- Evidence: `H:/tmp/offeru/host-neutral-live-20260930/{result,calls,native-events}.json`. Reproducible script: `backend/scripts/e2e/test_agent_access_binding.py`. Native frozen API serving was **not run** because 8766 is occupied; `--asgi` uses an isolated real in-process API and database. No user service was stopped or reused. This is bootstrap acceptance, not a signed installer or complete Career Task acceptance.
- Still failing on baseline: the Registry architecture gate reports `optimize_agent_chat_stream` directly invoking a mutating Agent service. This PR neither removes the gate nor treats that pre-existing failure as success.
- Not implemented by slice 1: provider routing for contextual career tasks, remote connector authorization, Director execution through external Agents, or the requested complete Codex discovery/material/review scenario. Subsequent slices must provide their own UI, permission, persistence and live execution evidence.
