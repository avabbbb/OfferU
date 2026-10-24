> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Settings / AI 连接 对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

信息架构方向正确（Connect → Auto → Ready，技术细节收进 Advanced），数据安全卡的确认-暂存-反馈流程是全站最接近 Apple 水准的部分；但 AI 连接流存在「编辑后密钥明文回填进表单」「config 重取整页表单被静默重置」「两处分离的保存按钮让 dirty 状态割裂」三处正确性/信任级缺陷，达不到上线标准。

**范围**: `frontend/src/app/settings/page.tsx` (1902 行) + `components/settings/JobSourceConnectionsCard.tsx` + `components/workbench/AgentConnectionPanel.tsx` + `lib/agentConnection.tsx` + `lib/hooks.ts`。已对照 AGENTS.md L77（vault_status 暴露）、README L176/L205（Advanced 承载 API 配置）、README_ZH L254（失败必须可见）。

## 页面结构事实

- **单页滚动，非 tab**。自上而下：Hero「连接你的工作伙伴」→ `AgentConnectionPanel` → `JobSourceConnectionsCard` → `LocalDataSafetyCard` → `LocalFeedbackCard` → `<details>` 高级设置（模型接口）→ 搜索配置 → 数据源 → 档案同步 → 邮箱推送 → 爬虫认证 → 底部「保存其他设置」。共 ~9 个区块，单文件 82KB。
- **视觉层级**：Hero 区 3 个 stat 卡（本机连接/启用来源/待保存数）；LLM 管理被正确藏在 `data-testid="advanced-model-settings"` 的 `<details>` 内（符合 README「lives behind Advanced」✓）。
- **保存模型分裂**：LLM 表有自己「保存模型配置」(apiDirty)，其余所有字段共用底部「保存其他设置」(settingsDirty)。Hero「待保存」= `apiDirty+settingsDirty` 求和，但两个按钮物理距离一屏以上，用户改了模型又改了关键词容易只按一个。
- **Advanced 入口**：README 说「只提供两种协议」属实 —— 后端 `llm_presets.py` 只返回 openai-compatible / anthropic-compatible 两个 preset（实测 GET /api/config/ 验证）。但 editor 里「接口协议」下拉只有这两项，预设本身不预填 base_url/model，与「配置模板」名不符。
- **auto-detect 呈现**：`AgentConnectionPanel` 做对了 —— 左侧候选列表（beginner 优先、recommended 标记、「更多 Agent」折叠非 beginner），右侧 4 步 SetupStep（找到→装 Skill→安全回读→同步），状态机 9 态全覆盖（missing/incompatible/integration_missing/outdated/check_required/ready/auth_required/blocked/failed），每 15s SWR 轮询 + stale>30s 提示 + offline 感知。**失败可见性好**：`last_error` 红框、sync failed 独立横幅 + 重试、probe/connect 失败进 activity log。
- **vault_status 暴露**：`config.py:698` 后端返回 `{available,error,read_error_count}`；前端 1367-1379 行在 Advanced 内对 `available=false` 显示红色「密钥不会被保存」横幅、available 时灰字「密钥只写入系统钥匙串」——**符合 AGENTS.md L77**，但只在 Advanced 展开后可见（见 Finding S-02）。
- **数据安全卡**：恢复需输入「恢复」二字确认 → stageRestore 暂存 → 下次启动前校验替换 + pre_restore 自动备份 + 可取消；Demo 重置/清邮件正文/清合成数据各有独立确认词（「重置 Demo」「清理旧正文」「清理合成邮箱」）；导出 JSON 带计数反馈。确认/进度/结果三段完整 —— 全站最佳。
- **实测后端**：`GET /api/config/` 返回 vault_status.available=true；active_llm_summary.source="active_config"；llm_api_configs 里 api_key=`env:OFFERU_L...`（env: 引用，符合不落盘要求）。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|----------|
| S-01 | P1 | bug | page.tsx:1120, 1161 | `openEditEditor` 把 `configItem.api_key` 直接 `setFormApiKey(configItem.api_key)`；`handleSubmitEditor` 再 `api_key: formApiKey.trim()` 原样写回 state | 编辑已保存配置时，若后端返回的是明文 key（旧数据或 env: 引用），密钥会以 password 字段明文驻留 React state，且「保存模型配置」会把它重新 PUT 回后端 —— 绕过钥匙串 dehydrate 的风险面；对 `credential_ref` 配置，api_key 字段显示空但 credential_ref 被保留，用户看到「密钥状态」列空白误以为丢了 key | 编辑时区分 `credential_ref`/`env:`/明文三类：credential_ref 在表单显示「已存钥匙串，输入新值覆盖」占位而非回填；保存路径保证含 `credential_ref` 的项不携带明文 api_key 提交 |
| S-02 | P1 | ux | page.tsx:1367-1379 | `vault_status` 横幅只渲染在 `<details>` 高级设置内部 | 钥匙串不可用时用户不展开 Advanced 就永远看不到「密钥不会被保存」——AGENTS.md 要求「必须经 /api/config 的 vault_status 暴露给用户」，埋在折叠区等于没暴露；影响面是**密钥静默丢失**，属 P1 级信任问题 | vault 不可用时提升为页面顶部（Hero 下方）全局横幅，不依赖 details 展开状态 |
| S-03 | P1 | bug | page.tsx:973-1028 | `useEffect(() => {… setSearchKeywords(…); setApiConfigs(normalized); … setApiDirty(false); setSettingsDirty(false);}, [config])` 对**整个** config payload 无差别重置所有表单 state | 任何一次 SWR 重验证（窗口聚焦、mutate()、其他页写入 config）都会把用户未保存的搜索关键词/Cookie/勾选的 sources_enabled 静默覆盖回服务器值，且 dirty 标志被一并清掉 —— 用户丢了输入还看不到「待保存」。`handleSaveApiSettings` 里 `await mutate()` 自身也触发该 effect，好在先 `setApiConfigs(normalizedConfigs)` 抵消，但 settingsDirty 一侧无此保护 | effect 内按字段 diff：仅在服务器值 ≠ 当前表单值且字段非 dirty 时回填；或把「服务器快照」与「表单草稿」分 state 存储，dirty 字段不回填 |
| S-04 | P2 | bug | page.tsx:1132, 1191, 1214 | 「已切换激活配置/配置已新增/配置已删除，请点击'保存模型配置'提交」三处提示把两步提交转嫁给用户 | 单选激活/删除只改内存 state，刷新页面即丢失；表格 radio 视觉上是即时控件（用户预期点选即生效），实际是「暂存+二次确认」——交互契约不一致，属「假成功」边缘（提示文案有救回，但模型配置保存失败时 radio 已翻转而未持久化） | 激活单条 config 可直接触发 `updateConfig`（单行写操作代价低）；删除走 confirm 后即时提交，不再要求二次保存 |
| S-05 | P2 | ux | page.tsx:1444 | 选中行 `bg-[#F0C020]`（bauhaus 黄）+ `hover:bg-[var(--surface-muted)]`；radio「是否激活」与行选中（黄底）是两个独立状态同列共存 | 「选中行」和「激活配置」视觉权重相同 —— 用户分不清黄底代表「选中待编辑」还是「生效中」；激活态只能靠每行 radio 圆点辨认，无行级徽标/边框 | 激活行加独立视觉（左缘粗边/「生效中」chip），选中态换中性色；或合并：点 radio 即选中+激活 |
| S-06 | P2 | bug | page.tsx:1109-1115 | `openEditEditor` 把 api_format 硬编码映射回 preset id（openai→"openai-compatible"）；`currentFormPreset` 仅按 `formProviderChoice` 查 presets | 若某 config 的 `api_format` 不在 presets 中（未来扩展/脏数据），`currentFormPreset` 为 undefined → `validateEditorForm` 报「请选择有效的接口协议」且提交时 `api_format` 被 `currentFormPreset?.api_format || previous?.api_format` 兜底 —— 编辑一个合法但未知格式的配置会强制要求改协议 | 未知 format 时下拉追加一个「自定义 (format)」禁用项，保存时保留 previous.api_format |
| S-07 | P2 | ux | page.tsx:1419 | 模型表 `min-w-[780px]` 六列，移动端 overflow-x-auto 横向滚动；列头「禁用」「是否激活」两列 checkbox/radio | 手机端需横滑才能点到激活 radio；「禁用」列语义重 —— 勾选后 provider 整体禁用，但视觉权重与激活相同，无二次确认（误触即 dirty） | 窄屏改为卡片式列表（每 config 一卡，激活/禁用为卡内开关）；禁用切换加 inline confirm 或至少 undo |
| S-08 | P2 | bug | page.tsx:226-268 TestLlmButton | `result` state 不随 active config 变化清空；`active_llm_summary` 来自 config prop，切换激活行后 summary 仍是旧值直到保存 | 用户切了激活配置 → 点「测试连接」→ 测的是**服务器上仍生效的旧配置**，但 result 无提示「测的是 Nemotron 3.5 Lightning」；切换后未保存时测试的是过期状态，结果绿勾会误导（「假成功」变体：测试真成功但对象不是用户以为的那个） | 测试按钮旁标注当前生效 service_name；apiDirty 时禁用测试并提示「先保存模型配置再测试」 |
| S-09 | P3 | ux | page.tsx:1330-1336 | Hero「待保存」stat 卡显示 `Number(apiDirty)+Number(settingsDirty)`（0/1/2） | 大数字「2」对普通用户无意义（两个模块待保存 ≠ 两条修改）；且它把两个独立保存域合并成一个数，点击不跳转、不可交互 | 改为列出具体待保存模块名（「模型配置」「搜索设置」chip），或做成可点击锚点跳到对应保存按钮 |
| S-10 | P3 | ux | page.tsx:1490-1545 | 「保存模型配置」按钮在 Advanced details 内底部；listFeedback 也在 details 内 | 用户新增配置后合上 details，保存按钮和「请点击保存模型配置提交」提示一起被折叠隐藏 —— 操作链条在视觉上断裂 | details 合起时在 summary 行追加 dirty 徽标（「未保存 ·n」），提示用户重新展开 |
| S-11 | P3 | bug | agentConnection.tsx:54 | `currentStatus`: `ready` 且 checked_at>120s 时降级为 check_required；`localReady` 同样 120s 窗口 | 回读验证通过后仅 2 分钟就显示「待检查」，用户刚连上就被提示再检查 —— 过度敏感的 staleness，损害「已验证」信任感；与底部「状态每 15 秒更新」矛盾（快照每 15s 刷新但 checked_at 是 probe 时间，不随轮询更新） | 区分「快照刷新时间」（15s）与「回读验证时间」（上次 probe）；ready 降级阈值放宽到 ≥10min 或改为「上次验证于 x 分钟前」的中性文案 |
| S-12 | P3 | ux | JobSourceConnectionsCard.tsx:134-138 | `AUTH_REQUIRED` 时渲染「去授权」Button，无 onPress、无 href | 按钮是纯装饰 —— 点了无反应。对「需要授权」的用户这是死路，比不显示更差（违背「失败必须可见且可操作」） | 挂接真实授权跳转（扩展引导页/BOSS 手动 Cookie 锚点），或在无可用动作时改为文字说明而非按钮 |
| S-13 | P3 | ux | page.tsx:1698-1702 | BOSS 连接状态仅一行灰字「已连接/未连接」，依赖 `bossCookie === "***已配置***"` 哨兵串 | 用魔法字符串当连接状态：后端若改哨兵值前端即静默失效；「未连接，采集会跳过该来源」是降级提示但无引导链接到扩展安装 | 后端应返回 `boss_cookie_set` 布尔（实际已返回！page.tsx:81-120 的 SettingsConfigPayload 未声明该字段却存在于响应）——改用布尔字段，未连接时给扩展安装指引链接 |
| S-14 | P3 | perf | page.tsx 整体 | 单文件 1902 行承载 9 个区块 + 3 个组件 + 4 个 Modal | 超出可维护阈值；LocalDataSafetyCard 内部又含 4 个 Modal + 7 种 action，已是独立模块复杂度 | 拆分：`LocalDataSafetyCard`/`LocalFeedbackCard`/LLM editor 表格+Modal 各成文件，page.tsx 只留编排 |
| S-15 | P3 | ux | page.tsx:394, 782 | `offeru-data-${stamp}.json` / `offeru-feedback-${stamp}.json` 文件名 stamp 由 `toISOString().replace(/[T:.Z]/g,"-")` 生成 | 生成形如 `2026-09-19-08-30-00-123` 含毫秒段，Windows 资源管理器排序尚可但可读性差 | `YYYY-MM-DD-HHmm` 即可 |

## Top-5 修复优先级

1. **S-03 表单静默重置** — 数据丢失级：用户正在编辑时被任何 config 重取覆盖且无 dirty 提示。修 diff-based 回填或草稿分层。
2. **S-02 vault_status 埋进折叠区** — 违反 AGENTS.md「必须暴露给用户」；提升为全局横幅。
3. **S-01 密钥回填/重提交路径** — 编辑流把 api_key 明文驻留 state 并原样回写，绕开 credential_ref 语义；区分三类密钥来源。
4. **S-04 激活/删除假即时** — radio/checkbox 视觉契约是即时生效，实为暂存；单行操作直接落库。
5. **S-12+S-08 死按钮与误导性测试** — 「去授权」无动作；「测试连接」测的是旧激活配置且无对象标注。

## 已达标的点（简短）

- **Advanced 承载属实**：模型接口管理整体收在 `<details>` 内，preset 只暴露 openai/anthropic 两协议，与 README「lives behind Advanced」一致。
- **AgentConnectionPanel 状态机完整**：9 态 + stale>30s + offline + 失败进 activity log + sync 失败独立重试 —— 符合「失败必须可见」。
- **数据安全卡为标杆**：恢复暂存+pre_restore 备份+可取消；四类危险操作各有独立确认词；导出/备份/完整性检查全有进度与结果反馈。
- **vault_status 后端链路通**：`config.py:698` 返回、前端有渲染（只是位置太深）。
- **密钥不落盘**：实测 llm_api_configs 的 api_key 为 `env:OFFERU_L...` 引用，active_llm_api_key 字段存在但配置侧走 credential_ref/env 引用。
- **诊断包脱敏**：`redactFeedbackText` 覆盖 Bearer/key=val/email/phone 四类；反馈包明确「不会自动上传」。

## UX 评分（对照 Apple 上线水准，10 分制）

| 维度 | 分 | 说明 |
|------|----|------|
| 信息架构 | 7/10 | Connect→Auto→Ready 方向对；9 区块单页滚动偏长但层级清晰；保存域割裂扣分 |
| AI 连接流 | 7/10 | auto-detect 状态机与步骤化优秀；ready 2min 降级、测试对象不明、激活假即时扣分 |
| 失败可见性 | 6/10 | Agent 面板/sync/探活失败可见性好；vault 横幅埋太深、表单静默重置、死按钮拉低 |
| 数据安全 UX | 9/10 | 确认词+暂存+自动 pre_restore+取消+结果反馈，全站最接近 Apple 水准 |
| 表单正确性 | 4/10 | config 重取整页覆盖 + 密钥回填 + 两步保存，正确性硬伤集中区 |
| 视觉一致性 | 6/10 | bauhaus 体系统一；选中黄 vs 激活态歧义、窄屏 780px 表横滑、Hero stat 无意义 |
| **综合** | **6.5/10** | 骨架到位，信任级缺陷集中在「表单状态管理」与「密钥生命周期可见性」两处 |
