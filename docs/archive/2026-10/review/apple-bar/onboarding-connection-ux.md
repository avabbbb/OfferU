> 已归档（2026-10-21）：本文不再是当前权威，只用于考古。当前文档：09-quality-and-release.md（位于 docs/）。2026-09-19 对抗评审的历史证据，评分与缺陷只属于当时代码。

# Onboarding 与 AI 连接 UX 对抗评审 — 2026-09-19

## 结论（对照 Apple 上线水准一句话定性）

「Connect → Auto → Ready」的**骨架是对的**（本机 Agent 自动发现 + 安全回读 + 渐进 checklist 都已落地，且优于多数开发者工具），但**最大的卖点「不需要 API key」在产品里一个字都没说**，第一步是 7 题性格测试而非核心价值动作，detect-agent 的关键中间态（`integration_missing` / `auth_required` / `check_required`）在新手面前缺一条"下一步该干嘛"的明确指令 —— 离 Apple 水准差的是"价值先行 + 话术消歧"，不是架构。

## 调研基线（来源）

- **Progressive onboarding 三层框架**（ReetLab, 2026-08）：第一层只放"达到 aha-moment 必需的动作"（约 20% 功能集），其余推迟；Slack 首跑只做"建频道 + 发一条消息"，Notion 用空态模板教学，Duolingo 把注册放在第一课**之后**。来源：https://reetlab.com/blog/progressive-onboarding
- **Empty-state = onboarding**（UX Encyclopedia）：空白屏是激活/流失的分叉口；"show value before asking for effort"；checklist 应预填 1 项（endowed progress, Kivetz 2006）；每步必须指向下一个动作，不能"完成即死路"。来源：https://ux.detroit3d.com/patterns/onboarding-empty-states.html
- **开发者工具的检测 UX**：Claude Code 官方 setup 把"验证"收敛到 `claude --version` + `claude doctor` 一条只读诊断命令，认证失败给"troubleshoot-install"错误对照表而非裸 stack（https://code.claude.com/docs/en/setup）；OpenCode 把 provider 接入收敛为 TUI 内 `/connect` 单命令 + 粘贴 key（https://opencode.ai/docs/）。两者共性：**检测结果是单条命令可复验的，失败文案直接挂"修复入口"**。

## Findings

| ID | Sev | Type | 位置 | 证据 | 问题 | 建议修法 |
|----|-----|------|------|------|------|----------|
| OB-01 | P1 | ux | `frontend/src/components/onboarding/OnboardingWizard.tsx:68-184, 805-889` | Wizard 第 0 步是 7 题"职业画像测试"，`isDisabled={!quizComplete}` 把"生成求职画像"按钮锁到全部答完 | 违背了三层框架的"layer-1 只做 aha-moment 必需动作"。新用户还没见到任何岗位/简历价值就先做问卷；每题都在付费流失率。MBTI 类比对外行也不直观 | 把 quiz 砍到 ≤3 题或改为"进来后可选"；把"保存第一个岗位"提前为第 0/1 步可直达动作；quiz 结果只用于预填 `targetRole`，不阻断主流程 |
| OB-02 | P1 | ux | `OnboardingWizard.tsx:638-639, 903-911` + `frontend/src/components/workbench/AgentConnectionPanel.tsx:132-137` | Wizard 步骤卡写"模型配置 / 把模型、密钥和接口地址接好"，面板标题却是"连接本机 Agent"；全产品 UI 中 grep 不到任何"不需要 API key / 无需密钥"字样（`grep -rn "不需要.*key\|无需.*key\|免费" frontend/src/components` → 0 命中）；该卖点只在 `README.md:200-202` | 旗舰差异化卖点"Codex/Claude/OpenCode 自带模型和认证，OfferU 不需要你填 API key"在产品里完全没讲。左侧导航还在用"模型配置/密钥"这类让用户以为要去填 key 的话术 —— 卖点被自家文案抵消 | 在 Wizard 步骤卡、AgentConnectionPanel 头部、checklist 第 1 步统一改为"连接你已登录的 Codex/Claude/OpenCode —— 无需 API key"；`stepDetails` 里"模型配置"改成"连接 Agent"；把 README §AI setup 那句 one-liner 原样搬进产品 |
| OB-03 | P1 | bug/ux | `OnboardingChecklist.tsx:36-42` + 实测 `GET /api/agent/runtime/connections` | 实测 codex `status=integration_missing`（`connection_verified=false`），checklist 判 `agentConnected` 要求 `status==="ready" && connection_verified && checked_at≤120s`；opencode 同样 `integration_missing` | 「detect-agent 失败路径的可见性」：用户即使装了 codex/opencode，只要还没点"连接 OfferU"完成 skill 安装+回读，checklist 第 1 步永远 0/1 —— 但 checklist 的 action 只是 `router.push("/settings")`，文案"检查连接"没说"要点一下连接 OfferU 按钮"。新用户会反复"检查"却不知还要手动 connect | checklist 第 1 步的 actionLabel/description 按 `integration_missing`/`auth_required`/`check_required` 分支给出具体动作（"点连接 OfferU"/"先在 Agent 里登录"/"点检查"）；或直接在 checklist 里嵌 mini connect 按钮，不把用户甩到 settings 页里找 |
| OB-04 | P2 | ux | `OnboardingWizard.tsx:1397-1458`（step 3） | 最后一步只给三个按钮"保存第一个岗位/查看岗位池/返回仪表盘"，三个卡片"保存岗位→自动准备→Today 跟进"是纯文字说明，无空态教学、无示例岗位、无"贴个 JD 链接试试"的低门槛入口 | 对照 Slack/Notion"空态即教学 + 给一个 first move"的惯例，这里是个 dead-end 三选一，没把"最低成本第一次成功"做出来。`AddJobModal` 里其实已有"本地准备（推荐）—— 不需要外部登录"的好路径，但 wizard 没把它前置 | step 3 直接内嵌一个"贴 JD 链接/职位描述 → 本地准备"的单输入框 CTA（复用 `preparationMode:"local"`），让用户在 wizard 里就完成第一个 job saved，而不是跳到 /jobs 再开 modal |
| OB-05 | P2 | ux | `frontend/src/lib/agentConnection.tsx:87-91` + `AgentConnectionPanel.tsx:140-144, 154-155` | SWR `refreshInterval:15000` 每 15s 重探；检测失败时面板顶部 banner 只有 `{state.error || "状态暂未更新…"}` + "重试"；`state.error` 来源是 `safeClientErrorMessage` 泛化文案 | 对照 Claude Code `claude doctor` / troubleshoot-install 表：检测失败的呈现是"泛化一句话 + 重试"，没有"失败属于哪一类（CLI 不在 PATH / 版本不兼容 / 未登录 / 超时）→ 对应修复入口"的分支。AGENTS.md:27 还记录了"探测超时 <20s 会静默吞掉 TimeoutError 批量误判 incompatible" —— 失败分类本就脆弱，更需要清晰分类呈现 | 把 `last_error`/status 枚举映射成"原因 → 修复动作"小表（仿 `STATUS` map 已有雏形，但 `failed`/`incompatible`/`blocked` 的 detail 仍是泛化文案）；超时/静默失败单独标注"可能是探测超时，重试一次" |
| OB-06 | P2 | design | `frontend/src/app/settings/page.tsx:1350-1544` + `README.md:204-209` | "高级设置：模型接口与技术细节"默认收起 ✅（符合 progressive disclosure），但展开后是 6 套 `*_api_key` 字段 + provider 表格 + 测试连接按钮，无一句"这是给没有本地 Agent 的用户的兜底" | README 说"API configuration is the fallback…It lives behind Advanced"，但 UI 里这段没有承接这个定位 —— 展开的人多半是没连上 Agent 的焦虑用户，第一眼看到 6 个 key 输入框会误以为"还是得填 key" | 在高级设置展开区顶部加一行定位说明："没有本地 Agent？才需要在这里配 API key。有 Codex/Claude/OpenCode 请回到上方连接。"并给"返回连接 Agent"锚点 |
| OB-07 | P2 | ux | `OnboardingWizard.tsx:742-750` + `providers.tsx:28-49` | "暂不设置"/`onSkip` 存在且 wizard 可跳过 ✅；但 `shouldShowWizard` 只看 `!wizardCompleted`，跳过写的是 `wizardSkipped:true` —— 之后 checklist 的"重新引导"靠 `resetWizard()` 重置。跳过后没有"从哪继续"的提示 | 框架要求"escape hatch + 可随时找回引导"。跳过重回 dashboard 后，新手唯一的找回入口是 checklist 里"重新引导"按钮 —— 但 checklist 只在 `!allStepsCompleted` 时显示，且没解释"为什么又看到它" | skip 时 toast/inline 提示"可随时在首页『快速开始』重新打开"；checklist 标题处加一句"未完成的基础配置"定位 |
| OB-08 | P3 | ux | `OnboardingChecklist.tsx:47-84` | 三步 checklist：连接 Agent → 建简历 → 存岗位，有 `completedCount/N` 进度条 ✅ | 对照 Kivetz endowed-progress：无一项预填/已暗示完成；三步顺序把"连接 Agent"放第一 —— 但 OB-02 已述这步话术会让用户以为要填 key。顺序本身没把"最快能成的"（存岗位/建简历）放前面给即时成就感 | 考虑把"保存首个岗位"提到第 1 步（`preparationMode:"local"` 不依赖 Agent），让 checklist 一进页面就可能有 1/3；或至少并行呈现而非暗示必须按序 |
| OB-09 | P3 | ux | `AgentConnectionPanel.tsx:14-23` + 实测 5 个 provider | `STATUS` map 有 9 态（missing/incompatible/integration_missing/outdated/check_required/ready/auth_required/blocked/failed），但实际列表里 beginner 只显示 codex/claude/opencode，gemini/pi 在"更多 Agent"里 | 状态机完备是优点，但对新手 9 态偏多；`check_required`（待检查）vs `integration_missing`（等待连接）的区分新手读不懂 —— "待检查"和"等待连接"听起来是同一件事 | 新手视角收敛为 3 态：能用（ready)/差一点（需登录/需点连接/需更新归一类）/未安装；9 态保留在"高级检查详情"折叠区（已有 `<details>`，把分类挪进去） |
| OB-10 | P3 | perf | `agentConnection.tsx:90` + `AgentConnectionPanel.tsx:250-252` | 每 15s 全量重探 + 每 15s 刷新 `now` 触发 stale 判定重渲染 | 15s 轮询对"装完 CLI 回来"的等待场景偏慢（用户装完 codex 回来看面板仍显示旧态最多 15s），且 `now` tick 让整个 panel 每 15s 重渲染 | 探测结果页加"我刚装好了，重新检测"手动触发已有（`refresh`）；可把 refresh 按钮做得更显眼；`now` 的 interval 与 SWR 对齐即可，不必单独 15s tick |

## 新用户从安装到第一个 job saved 的摩擦点清单（按时序）

1. 打开 → `BackendReadyGate` 等待后端（≤45s，有 slow hint，可接受）。
2. 全屏 Wizard 弹出 → 第 0 步被要求做 7 题性格测试，全部答完才解锁"生成求职画像"（OB-01）。
3. 第 1 步"模型配置"话术让人以为要填 API key；实际是本机 Agent 检测 —— 卖点"不需要 key"完全没讲（OB-02）。
4. 若已装 codex/opencode 但没点"连接 OfferU"，`integration_missing` 状态下 checklist 仍判未连接，且不知道该点哪里（OB-03）。
5. 第 3 步三个按钮跳去 /jobs，最低门槛的"贴 JD → 本地准备"路径没被前置（OB-04）。
6. 跳到 /jobs 空态有"保存第一个岗位"CTA ✅，但 modal 里"本地准备 vs 实时研究"的区分对没连 Agent 的用户是好消息却藏在 modal 里（AddJobModal.tsx:145-173）。

## detect-agent 失败路径的可见性

- 有：`state.error` banner + 重试、`last_error` 黄条、9 态 `STATUS` map、"高级检查详情" `<details>`、stale>30s 提示、offline 检测（AgentConnectionPanel.tsx:140-144, 179, 199-222, 250-252）。
- 缺：失败**分类→修复动作**的映射（都是泛化文案）；探测超时静默吞掉的风险（AGENTS.md:27 记录 `<20s` 超时 `except:pass`，无用户可见区分）；`integration_missing` 时 checklist 侧无"去点连接"指令（OB-03）。

## 「不需要 API key」卖点是否讲清楚

**没有。** 全产品 UI `grep` 零命中（OB-02 证据）；README.md:200-202 那句"the agent brings its own model and authentication"是唯一定位，但没进任何 UI 字符串。同时 settings 高级区一展开就是 6 个 `*_api_key` 输入框，视觉上反而强化了"要填 key"的错误预期（OB-06）。

## Top-5 修复优先级

1. **OB-02** 把"无需 API key —— 用你已登录的 Codex/Claude/OpenCode"写进 wizard 步骤卡、AgentConnectionPanel 头、checklist 第 1 步；把"模型配置"标签改名"连接 Agent"。（一句话成本，卖点立刻兑现）
2. **OB-03** checklist 第 1 步按 `integration_missing`/`auth_required` 分支给"点连接 OfferU"/"先在 Agent 登录"的具体动作，或直接嵌 connect 按钮 —— 堵住"装了 Agent 却永远 0/1"的断点。
3. **OB-01** 砍掉/后置 7 题 quiz 的强制完成门槛，让"保存第一个岗位"成为可最早到达的动作（对标 Slack/Duolingo 的 value-first）。
4. **OB-04** wizard 最后一步内嵌"贴 JD/链接 → 本地准备"单输入框 CTA，把第一个 job saved 收在 wizard 内完成。
5. **OB-05** detect-agent 失败按"原因→修复"分类呈现（含探测超时单独提示），对齐 `claude doctor` 的可复验诊断体验。

## 已达标的点（简短）

- 本机 Agent 自动发现 + beginner 过滤 + 推荐排序（codex `recommended:true`）+ skill 自动安装 + 一次性安全回读验证 —— 比 Claude Code 手动 `/connect`、OpenCode 手动粘贴 key 的接入路径**更省心**，架构层是领先的。
- 检测状态机完备（9 态 + capability matrix + `last_error` 透传 + stale/offline 双提示），安全边界清晰（"不替你登录、不读职业数据"）。
- 高级 API 配置默认收进 `<details>`，符合 progressive disclosure；密钥只写系统钥匙串有明示。
- 跳过/重开引导、空态"保存第一个岗位"CTA、`preparationMode:"local"` 不依赖 Agent 的兜底路径都已存在。
