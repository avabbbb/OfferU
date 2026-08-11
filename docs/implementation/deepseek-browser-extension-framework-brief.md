# DeepSeek：OfferU 浏览器扩展框架实施任务书

> 用途：把本文直接交给新的 DeepSeek 实现会话。  
> 本文只授权按切片修改代码，不授权真实投递、外部账号操作或同一会话自评通过。  
> 总计划：[单浏览器扩展纵向切片](../architecture/browser-extension-unification-slices.md)

## 0. 你的角色

你是 OfferU 浏览器扩展的实现 Agent。你不是产品设计者，不是牛客插件移植 Agent，也不是本轮 Eval 裁判。

事实源按顺序为：

1. `AGENTS.md`
2. `CONTEXT.md`
3. `docs/adr/0049-unify-browser-job-collection-and-application-form-fill.md`
4. `docs/architecture/browser-extension-framework.md`
5. `docs/architecture/site-rule-pack-v1.md`
6. `docs/design/browser-extension-interaction.md`
7. `docs/architecture/browser-extension-unification-slices.md`
8. 当前任务明确指定的一个切片

发生冲突时停止并报告，不自行发明新架构。

## 1. 绝对边界

- 不修改、反编译后复制或打包 `Niuke/`；不复制其中的选择器表、压缩代码、CSS、图片或私有协议。
- 不调用牛客登录、Cookie、验证码、简历、匹配、遥测、截图或配置接口。
- 不增加 `<all_urls>` 常驻内容脚本，不保存完整简历或模型 API Key。
- 不填写敏感/承诺/同意/文件/开放题，不覆盖已有值。
- 不查找、点击、模拟或代理最终提交按钮；不得调用 `form.submit()` 或 `requestSubmit()`。
- 不绕过 Operation Registry，不直接写数据库，不新增第二套投递事实模型。
- 规则包只能是数据并引用已知 `driverId`，不得带任意代码 hook、远程脚本或动态模块。
- 不把测试通过、表单填完、岗位入库写成“已投递”。

## 2. 实施顺序

每次会话只领取下面一个任务，完成后回传并停止。不要在一个会话铺开全部模块。

### EXT-FRAME-001：规则框架骨架

只建立 `SiteRulePack` 类型、成熟 schema validator、Registry、Resolver、消息合同和最小 fixture harness。先用两个纯测试 pack 证明：唯一 verified 命中、低置信、规则冲突、experimental 只诊断、未知 driver、非法 selector 和任意脚本字段拒绝。

不迁移真实站点，不改 UI，不接后端。

### EXT-JOB-001：迁移一个岗位详情页

只选现有五个平台中的一个，把 `PlatformConfig` 迁移为 `SiteRulePack(job-detail)`，打通“显式注入 → 预览 → 加入本地岗位篮”。旧配置只能作为薄适配层；不要同时迁移其他平台。

### EXT-JOB-002：岗位同步闭环

建立批量岗位导入 Operation 与薄 HTTP Adapter，接通 side panel 的显式确认、逐条结果、幂等和离线保留。不要碰 SmartFill。

### EXT-UI-001：Side Panel 壳

用 WXT 正式 entrypoint 建立侧边栏、Background Coordinator 和 unlisted Page Agent 注入。先覆盖离线、受限页、识别中、已验证岗位页、实验规则、规则冲突状态。删除 popup 双入口和根目录陈旧构建事实源。

### EXT-JOB-003：其余岗位规则包

每轮最多迁移一个 portal pack，并各自提供正例、近似反例、冲突例和真实浏览器证据。不得批量复制后宣称五站支持。

### EXT-FILL-001：迁移一个 ATS 的只读规则

只迁移检测信号、别名、结构 selector 和能力，Writer 仍是内置代码。先打通 `扫描表单（不会填写）` 与四组预览；DOM 必须零变化。

### EXT-FILL-002：安全确认与写入

只打通一个 verified ATS fixture 的计划绑定、二次确认、空白非敏感写入、逐字段验证和失效拒绝。不实现更多 ATS，不实现提交证据。

### EXT-FILL-003：逐 ATS 扩展

每轮只增加一个规则包或一个已知 ControlDriver。规则与 Driver 分开验收；规则不准藏 Writer 代码。

### EXT-RECEIPT-001：提交候选

最后实现同一短期会话中的最小回执候选、人工确认和 Registry 原子建档。普通页、校验错误、草稿和模糊成功页必须是反例。禁止增加最终提交执行代码。

## 3. 每个实现会话的固定步骤

1. 完整读取本任务书的事实源。
2. 运行 `git status --short`，记录用户已有改动；不得 reset、checkout、stash 或覆盖。
3. 用不超过 10 行写出：本轮唯一 Task ID、允许文件、验收映射、明确不做。
4. 读取直接相关代码后再修改；优先复用现有 `smartfill-v2` scanner/writer，不重写整条 pipeline。
5. 只修改任务允许范围；发现必须越界就停止提问。
6. 使用 `apply_patch` 修改文件；不顺手重构。
7. 按 `AGENTS.md`，实现会话不运行构建、typecheck 或测试，只列出应由独立 Eval 会话执行的命令。
8. 输出 `IMPLEMENTATION_HANDOFF_V1` 后停止，不在同一会话扮演 Eval Agent。

## 4. 实现回传格式

```text
IMPLEMENTATION_HANDOFF_V1
task_id: EXT-...
status: READY_FOR_EVAL | BLOCKED
commit: <完整 SHA 或 dirty-worktree>
dirty_before: [...]
changed_files: [...]
acceptance_mapping:
  - <验收项> -> <文件:行号/实现证据>
niuke_code_or_rules_copied: false
new_permissions: [...]
operation_registry_changes: [...]
commands_not_run:
  - <命令>
known_gaps: [...]
blocking_question: none | <唯一问题>
recommended_eval_focus: <一个最关键风险>
```

`status=READY_FOR_EVAL` 只表示等待独立验证，不表示功能完成或可以发布。

## 5. 独立 Eval 会话

实现回传后，使用者另开一个 DeepSeek 会话，明确授权它作为只读 Eval Agent。该会话先读取：

- [`deepseek-loop-eval-guide.md`](../evals/deepseek-loop-eval-guide.md)
- 本任务书
- 本次 `IMPLEMENTATION_HANDOFF_V1`
- 当前 Task 相关 fixture 与验收项

Eval 会话不得修改产品代码、测试、规则、grader 或 ADR。先做 targeted replay；通过后才扩大回归。扩展验收至少分开报告：

1. typecheck/test/build；
2. WXT 产物和 manifest 权限快照；
3. 真实 Edge/Chrome 侧载、side panel、console/network；
4. 直接用户症状；
5. DOM before/after 与字段级 outcome；
6. Operation audit/数据库 outcome；
7. 隐私、存储和最终提交静态禁令；
8. 未覆盖站点/控件。

不能只贴“全部通过”，也不能把 jsdom 单测当成真实浏览器证据。

## 6. 扩展 Eval 回传格式

```text
EXTENSION_EVAL_HANDOFF_V1
validity: VALID | INVALID
task_id: EXT-...
implementation_commit: <完整 SHA>
dirty_before: [...]
dirty_after: [...]
commands_and_exit_codes: [...]
manifest_snapshot: <artifact path>
browser_trace_or_screenshots: [...]
console_errors: [...]
network_failures: [...]
dom_before_after: <artifact path | not-applicable>
operation_outcome: <artifact path | not-applicable>
passed_assertions: [...]
failed_assertions: [...]
blocked_assertions: [...]
real_external_submission_performed: false
secrets_or_private_values_in_artifacts: false
first_critical_failure: <一句话 | none>
minimum_reproduction: <命令或浏览器步骤>
recommended_next_slice: <只写一个>
```

报告与 artifacts 放到 `docs/evals/reports/artifacts/<run-id>/browser-extension/`。不要伪造 `offeru-core-v1` 的 24 Task 正式报告；只有实际完整运行该 suite 时才能生成对应 `eval-summary`。

## 7. 可直接粘贴给 DeepSeek 实现会话的提示词

```text
你是 OfferU 浏览器扩展的实现 Agent。只实施任务 <EXT-TASK-ID>，具体目标为 <一句话>。

先完整读取 AGENTS.md、CONTEXT.md、ADR-0049、
docs/architecture/browser-extension-framework.md、
docs/architecture/site-rule-pack-v1.md、
docs/design/browser-extension-interaction.md、
docs/architecture/browser-extension-unification-slices.md 和
docs/implementation/deepseek-browser-extension-framework-brief.md。

严格遵守：
- 不复制或修改 Niuke/，不调用牛客私有接口；
- 规则是数据，复杂控件 Driver 是扩展内打包代码；
- 不使用 <all_urls> 常驻脚本，不持久化简历/API Key；
- 只填空白非敏感字段，不自动提交；
- OfferU 事实写入只走 Operation Registry；
- 一次只做一个纵向任务，不越过允许文件范围；
- 保留用户 dirty worktree，不 reset/checkout/stash；
- 本实现会话不运行测试/build，不自评通过。

开工前用不超过 10 行复述任务、允许文件、验收映射和明确不做，
然后读取现有代码并以最小改动实施。结束时只给 IMPLEMENTATION_HANDOFF_V1，
列出建议由独立 Eval 会话执行的命令与最关键风险。
```
