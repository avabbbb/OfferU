# OfferU 文档导航

本文只回答两个问题：现在什么是事实源，以及旧文档还应该怎样使用。

## 事实优先级

1. [`CONTEXT.md`](../CONTEXT.md)：领域语言、产品边界和不可混用的概念。
2. [`docs/adr/`](./adr/) 中最新的 `accepted` ADR：已经确认的架构决策。
3. 当前代码与 `python -m app.cli manifest --pretty`：真实可执行能力。
4. [`docs/architecture/`](./architecture/)：当前架构说明、外部参考对齐与日期化验收记录。
5. 日期化审计、路线图和实施计划：历史上下文，不覆盖以上事实源。

当聊天总结、旧计划或 README 与 accepted ADR 冲突时，以最新 accepted ADR 为准。

## 当前架构

| 文档 | 用途 |
|---|---|
| [Agent System](./architecture/agent-system.md) | 内置 Pi Agent、外部 Coding Agent、Operation Registry 和安全边界 |
| [CareerOps alignment](./architecture/career-ops-alignment.md) | OfferU 借鉴了什么、没有复刻什么、还缺什么 |
| [Runtime acceptance 2026-07-30](./architecture/runtime-acceptance-2026-07-30.md) | Pi、Codex、Claude 的一次现场验收与外部阻塞快照 |
| [ADR 0046](./adr/0046-use-pi-sdk-worker-for-main-agent-runtime.md) | Pi SDK 是内置主 Agent 的运行时底座 |
| [ADR 0047](./adr/0047-use-vite-static-spa-for-tauri-frontend.md) | Tauri 使用 Vite 静态 SPA，不再使用 Next.js 开发服务器 |

## 历史快照

下列文档保留原始决策过程和验收意图，但不再表示当前完成度：

| 文档 | 当前用途 |
|---|---|
| [Backend capability audit 2026-07-16](./BACKEND_CAPABILITY_AUDIT_2026-07-16.md) | 早期能力与风险基线 |
| [Implementation roadmap 2026-07-17](./IMPLEMENTATION_ROADMAP_2026-07-17.md) | 四个垂直闭环的原始发布门 |
| [WebUI workbench design 2026-07-17](./WEBUI_WORKBENCH_DESIGN_2026-07-17.md) | 工作台信息架构和交互意图 |
| [WebUI Slice 01](./implementation/WEBUI_SLICE_01_APPLICATIONS_PLAN_2026-07-17.md) | 投递进展首切片的历史实施计划 |

本地被 `.gitignore` 排除的调研草稿、PoC 方案和个人笔记不是项目事实源。若其中结论仍有效，应压缩进 `CONTEXT.md`、accepted ADR 或 `docs/architecture/`，而不是继续让多个大文档并行维护同一事实。

## 维护规则

- README 面向第一次进入项目的人，只保留定位、真实入口、当前边界和下一步。
- 架构选择写 ADR；动态数量从 CLI manifest 发现，不在多个文档重复维护。
- 现场验收使用日期化文件，记录版本、环境、成功项和外部阻塞。
- 实施计划完成后改成历史状态，不再把“待实施”留在当前文档入口。
- 不删除 superseded ADR；通过 front matter 明确替代关系。
