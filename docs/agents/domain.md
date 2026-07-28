# Domain Docs

OfferU 采用单上下文领域文档布局。前端、Python 业务后端和 Tauri/Rust 系统桥接共享同一套求职领域语言与系统级架构决策。

## Before exploring

- 阅读根目录 `CONTEXT.md`；
- 阅读 `docs/adr/` 中与当前任务相关的 ADR；
- 若文件不存在则静默继续，不为填充目录而提前制造术语或决策。

## Use the glossary vocabulary

Issue 标题、重构提案、测试名称和实现说明必须使用 `CONTEXT.md` 定义的领域术语，并避开其中明确列出的同义误称。需要的新概念若尚未定义，应判断它是命名漂移还是实际领域缺口；实际缺口通过领域建模流程补充。

## Flag ADR conflicts

任何输出若与现有 ADR 冲突，必须明确指出冲突的 ADR 编号与理由，不能静默覆盖。需要改变已接受决策时，新建取代 ADR，并保留旧决策的历史状态。
