# Autonomous Goal Handoff

Updated: 2026-08-28

## Where work is now

上一轮 R1-R6 fixture/replay baseline 已关闭。本轮 C1 已收口：legacy applications/calendar/interview/profile/resume/templates/studio/scraper 等 Route 已通过 Operation Registry helper；新增 source audit 证明 route 层没有直接 ORM DML/mutator 或直接调用 mutating service。`job-search` 真实公开源插件已经完成 Manifest/Skill/CLI/生命周期契约，generic Role Intelligence live smoke 完成但当前目标只得到 `3/15` exact cohort，因此 Runtime 正确返回 `INSUFFICIENT_SAMPLE`。当前 targeted Role/Agent/Interview suite 为 `74 passed`，插件套件 `7 passed`。

## Current blockers

- Codex live collection: `BLOCKED_EXTERNAL_AUTH`; local `codex-cli 0.149.1` currently reports `Not logged in`. Do not modify credentials or proxy.
- DSH has bridge/plugin protocol coverage but no independently configured DSH AgentRunProvider live path.

## Next exact actions

1. Rerun the full backend suite and frontend typecheck/build after the plugin, benchmark-status and provider-neutral UI changes.
2. Read the Playwright instructions, then rerun browser smoke for Main Agent provider-neutral UI, plugin install/uninstall, Role Intelligence live/insufficient-sample display, and Job Saved automation.
3. Audit the final diff and update the C1-C10 gate evidence; keep Codex real auth as `BLOCKED_EXTERNAL_AUTH` and DSH as not independently live-verified.

## Do not break

- Preserve unrelated dirty-worktree changes and malformed/untracked DSH paths.
- Do not modify Codex credentials, API keys, auth mode, proxy or provider selection.
- Career Truth remains in OfferU; no automatic submit/send; no silent Profile/Memory fact writes.
- Fixture/replay data remains visibly labelled and never becomes live-market evidence.

## Do not break

- Operation Registry is the only high-risk business mutation gateway.
- Career Truth stays in OfferU.
- No automatic submit/send and no silent Profile/Memory fact writes.
- Preserve all unrelated dirty-worktree changes.
- Fixture data remains explicitly labelled.
- `G2B` remains `BLOCKED_EXTERNAL_AUTH` while Codex CLI is not authenticated; do not alter credentials, proxy, or provider configuration.
- The isolated E2E database/temp plugin state used for acceptance must not be confused with `backend/djm.db` or the real plugin registry.
