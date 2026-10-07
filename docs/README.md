# OfferU 文档

> 状态：**当前文档入口** · 重构于 2026-10（旧文档见 [archive/](./archive/README.md)）

## 一句话

**给 OfferU 一个岗位，它会告诉你：这个岗位真正要什么，你能拿出什么证据，下一步该准备什么。**

OfferU 是一个本地优先（local-first）的求职工作台。你的职业事实、岗位、简历版本、投递进展和面试复盘都保存在你自己的电脑上。AI 负责研究、判断和起草；需要你做决定的事情，由你来决定。

```text
保存一个岗位
  → 岗位要求 × 你能证明的经历
  → 岗位工作区：研究 · 证据 · 定制简历 · 投递 · 面试
  → 「今天」告诉你下一步
  → 结果回流到职业档案，下一次更准
```

## 文档地图（共 10 篇）

| # | 文档 | 回答的问题 |
| --- | --- | --- |
| 00 | 本页 | OfferU 是什么，文档怎么读 |
| 01 | [总体设计](./01-overall-design.md) | 给谁用、核心闭环、信息架构、系统边界、权威模型、术语 |
| 02 | [交互设计](./02-interaction-design.md) | 导航、打断规则、审批呈现、防死锁、不硬编码、文案规范、已知交互缺陷 |
| 03 | [模块：职业档案与记忆](./03-module-profile.md) | Career Truth、证据、候选审核、记忆分层、渐进建档 |
| 04 | [模块：岗位工作区](./04-module-job-workspace.md) | 岗位采集、排序、Role Intelligence、Evidence Map、投递协助 |
| 05 | [模块：简历](./05-module-resume.md) | 文档式编辑、按岗位定制、AI 改动呈现、版本与导出 |
| 06 | [模块：投递进展](./06-module-pipeline.md) | 投递阶段、邮件/日历/平台信号、进展候选、跟进 |
| 07 | [模块：面试](./07-module-interview.md) | 分轮准备、练习、逐题复盘、学习回流 |
| 08 | [模块：Agent 运行时与安全](./08-module-agent-runtime.md) | Agent 接入、Skill、Operation Registry、Run 生命周期、权限与审批 |
| 09 | [质量与发布](./09-quality-and-release.md) | Eval 体系、可靠性与安全不变量、发布门槛、证据规则 |

推荐阅读顺序：**新用户或贡献者** 00 → 01 → 02；**做某个模块** 01 → 02 → 对应模块；**做 Agent / 安全** 01 → 08 → 09。

## 权威顺序（只有三层）

```text
1. 本目录 00–09            ← 产品与架构的唯一设计权威
2. 实时代码 / Operation Registry / 生成的 Skill 投影   ← 「现在实际做到了什么」
3. docs/evidence/ 下的验收报告                         ← 「某个版本被证明做到了什么」
```

- 设计文档与代码不一致时：先判断是代码缺陷还是文档过时，然后**在同一个 PR 里**修正其中一方。
- `docs/archive/**` 只用于考古，不覆盖以上三层。

## 根目录保留的文件

| 文件 | 为什么留在根目录 |
| --- | --- |
| `README.md` / `README_ZH.md` | 项目门面 |
| `QUICKSTART.md` | 安装与首次运行 |
| `DEVELOPMENT.md` | 开发环境与命令 |
| `AGENTS.md` | Coding Agent 的施工约束 |
| `RELEASE_CHECKLIST.md` / `KNOWN_ISSUES.md` / `RELEASE_NOTES.md` | 发布脚本（`backend/scripts/release/*`）和 CI 直接读取 |
| `SECURITY.md` | GitHub 安全策略约定位置 |
| `LICENSE` / `THIRD_PARTY_NOTICES.md` | 法律文件 |

## 文档维护规则

1. **总数不超过 10 篇。** 不新增 dated 设计稿或「vNext 方案」，直接修改对应文档。
2. **每篇不超过约 300 行。** 超过时先删掉重复和过时内容，不要拆出新文件。
3. **不写会过期的数字**，比如测试通过数、Operation 数量、commit 号、模型名。这些以实时代码和 `docs/evidence/` 为准。
4. **提案要标注。** 尚未被产品负责人确认的设计，用 `> PROPOSAL` 块标出；确认后去掉标记。
5. **验收报告不是设计。** 新报告放在 `docs/evidence/reports/YYYY-MM-DD-<slug>.md`，必须写明 commit、运行时和模型；格式见 [09](./09-quality-and-release.md)。
6. **归档方式。** 过时内容用 `git mv` 移到 `docs/archive/`，保留原有路径结构，在文件开头加一行归档说明，并更新 [archive/README.md](./archive/README.md) 的映射表。
7. **改了用户可见的交互，就同步改 02。** 改了某个模块的规则，就同步改对应的模块文档。
