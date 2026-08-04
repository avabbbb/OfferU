# Agent Runtime 现场验收记录

- Date: 2026-07-30
- Scope: Pi 主 Agent 与 Codex / Claude hosted executor 的运行时边界
- Environment: Windows, Python 3.12.0 project venv, Node 24.14.0
- Formal build/test status: not run, following `AGENTS.md`

> 本文是现场验收快照，不是当前架构规范。当前边界见 [Agent System](./agent-system.md)；新验收结果应追加新的日期化记录，不覆盖本次外部阻塞。

## 1. Runtime baseline

| Runtime | Version | Probe result | Current role |
|---|---:|---|---|
| Pi coding-agent SDK | 0.82.1 | Packaged and protocol-probed | Built-in main-Agent loop only |
| Codex CLI | 0.144.1 | Available; App Server contract compatible | Hosted heavy-task executor |
| Claude Code | 2.1.220 | Available | Local authentication/runtime host |
| Claude Agent SDK | 0.3.220 | Available; structured/session contract compatible | Hosted heavy-task executor |
| Gemini CLI | Not installed | Unavailable | Explicit compatibility path only |
| OpenCode | 1.17.11 | Detected but contract unsupported | No fallback |

On Windows, executable discovery must prefer the runnable npm `.cmd` launcher over
the adjacent extensionless POSIX shim. The system `python` currently resolves to
Python 3.9.12, so runtime probes and backend startup must use
`backend/.venv312/Scripts/python.exe` until the launcher is made authoritative.

## 2. Acceptance matrix

| Contract | Result | Evidence |
|---|---|---|
| Codex App Server initialize/thread/turn handshake | Reached provider | OfferU completed the JSONL initialize and thread/turn path; the configured upstream then returned HTTP 403 because that account has outstanding balance |
| Codex error and process cleanup | Passed locally | Provider 403 is returned as the original failure instead of being masked by a 120-second close timeout; the exact process tree is terminated on Windows |
| Codex structured result | Blocked externally | Requires the configured Codex upstream account to be restored |
| Codex cancel/resume | Blocked externally | Protocol mapping is implemented, but live provider completion cannot be exercised while the same upstream returns 403 |
| Claude structured result without web tools | Passed | Strict JSON Schema output completed and retained one external SDK session ID |
| Claude cancellation | Passed | Immediate cancellation reached terminal `cancelled`, persisted no result, and did not allow a late completion to overwrite the state |
| Claude interruption and resume | Passed | A simulated backend interruption persisted `interrupted`; rerunning the identical task reused the same external session ID and completed |
| Claude provider-event normalization | Passed | Product audit retains lifecycle, tool name/ID, target host, elapsed time, result size, usage, and terminal state; raw thinking, fetched bodies, and token-by-token deltas are not persisted |
| Claude public WebSearch/WebFetch invocation | Invoked but evidence unavailable | Both tools were requested and completed through the SDK allowlist, but the current local custom Anthropic upstream returned empty search evidence and rejected GitHub fetch safety verification |
| OfferU business isolation | Passed by configuration and trace | Hosted research receives no OfferU Operations, database access, shell, filesystem tools, Skills, or subagents |

## 3. What the live checks changed

- Codex runtime discovery now selects a Windows-runnable launcher.
- Codex starts with apps, browser/computer use, image generation, multi-agent,
  shell, unified exec, workspace dependencies, MCP servers, and project
  instructions disabled for this first public-research grant.
- Codex shutdown is bounded and terminates the exact child process tree.
- Hosted-session timestamps are refreshed after commit, avoiding async ORM
  lazy-load failures.
- Cancellation is remembered even if requested before provider process creation,
  and `cancelled` is an immutable terminal state.
- Claude audit events are provider-neutral and bounded. A hosted task has a
  maximum of eight model turns and does not persist partial token deltas.

## 4. External blockers

1. The currently configured Codex upstream must clear its account/balance error
   before Codex structured output, cancellation, and resume can be accepted live.
2. Claude currently uses a custom loopback `ANTHROPIC_BASE_URL`. Its model and
   structured-output path works, but its web-tool bridge did not return usable
   evidence. Live public research must be retested against an upstream that
   explicitly supports Claude Code `WebSearch` and `WebFetch`.
3. Consumer/local Claude authentication is suitable only for the current
   local-single-user development workflow. A distributed product must use an
   Anthropic Console API key or supported cloud-provider authentication rather
   than routing a user's personal OAuth credentials.

## 5. Hosted-session UI delivery

The hosted-session timeline is now connected in `AgentPanel`:

- show executor, provider protocol, task grant, status, and external session ID;
- render normalized lifecycle and tool events without raw provider payloads;
- expose cancel for live sessions and resume only for compatible interrupted
  sessions;
- show external account/network blockers as actionable failures;

The UI reads and acts through thin Operation Registry projections. It does not
import hosted runtime or job-research services directly. A Playwright browser
pass confirmed the empty state and updated
`asset/screenshots/agent-workbench.png`.

## 6. Candidate-evidence handback delivery

The evidence handback slice is now implemented:

- a completed research run remains `candidate` and no longer updates the active
  company or role dossier;
- the job-detail page displays findings, evidence levels, source links,
  evidence snapshots and gaps;
- accept/reject is a persisted `review_job_research` Operation shared by the
  Web surface and Agent Skills; rejection requires a reason;
- only acceptance publishes the run to the active dossiers;
- pre-application decisions, resume optimization and AI interviews now require
  `review_status=accepted`;
- rejected or unreviewed research remains auditable but cannot enter downstream
  prompts or decisions.

Browser acceptance covered the real empty state and a read-only mocked
candidate with three sources, three findings and one gap. It confirmed both
review actions and produced `asset/screenshots/job-research-handback.png`
without writing the demo candidate to the OfferU database. Formal build,
typecheck and test commands were not run, following `AGENTS.md`.

The next hosted-executor slice is non-evidence file-artifact handback and
multi-version Provider acceptance. The Codex and custom-Claude upstream
blockers in section 4 still apply.

After the two upstream blockers are removed, rerun the same immutable task
contracts and attach the resulting terminal session/event summaries here.

## 7. Protocol references

- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server/)
- [OpenAI Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
- [Claude Agent SDK overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK authentication](https://code.claude.com/docs/en/agent-sdk/authentication)
