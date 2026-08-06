# 复杂 Eval 场景设计（2026-08-06）

> 目的：覆盖「复合指令」「中断恢复」「错误修正」三类真实使用模式，验证主 Agent +
> Operation Registry + 幂等/恢复机制在压力下的行为。不是正式 offeru-core-v1 suite，
> 是人工/半自动验收剧本。执行入口：主 Agent 对话框（`#/agent`）、CLI `run`/`confirm`、
> 直接 HTTP。

## 场景总览

| ID | 场景 | 核心验证点 |
|---|---|---|
| E1 | 复合指令一次性多目标 | 多目标拆解、串行执行、HITL 确认聚合 |
| E2 | 中途强制终止 + 恢复 | 幂等、resume 不重复、状态一致 |
| E3 | 错误信息/无来源注入 | 事实门、证据门拦截 |
| E4 | 半途修正方向 | 撤销/取代链、不污染已完成部分 |
| E5 | 服务器重启恢复 | recover_interrupted_agent_runs |

---

## E1 复合指令（一次输入多个命令）

**输入**（单条消息，全部串在一起）：
```
帮我做三件事：
1. 把岗位 #88 的分诊状态改为 picked（如果已经是就算了）
2. 在档案里补一条项目经历：做过 AIGC 视频创作工具的产品设计（来源：智绘画布项目）
3. 把今天的待办里没确认的投递进展信号列出来给我看
```

**期望行为**：
- [ ] 主 Agent 拆解出 3 个独立目标并规划顺序（不并行乱改）
- [ ] 写操作（triage / add_profile_evidence）各自停在确认点，一次性展示待确认清单
- [ ] 只读操作（列进展信号）直接完成，不阻塞
- [ ] 确认后 3 个目标全部完成，Run 终态 completed

**验收命令**：
```bash
# 确认前
curl -s http://127.0.0.1:8765/api/agent/runs?limit=1 | python -m json.tool | grep -E "status|goal"
# 确认后核对
curl -s http://127.0.0.1:8765/api/jobs/88 | grep triage_status
curl -s http://127.0.0.1:8765/api/memory/ledger?status=accepted | head
```

**关注点**：
- 目标 2 的档案条目必须带来源（智绘画布）且过事实门；无来源版本应被拒
- 目标 1 幂等：已是 picked 时不得重复写审计

---

## E2 中途强制终止 + 恢复（重点）

**前置**：启动一个岗位调研（`start_job_research` runtime=omp），跑 ~60 秒。

**操作**：直接 `taskkill /F /PID <后端pid>` 杀掉服务器（或按 Ctrl+C）。

**期望行为**：
- [ ] 重启后 `recover_interrupted_agent_runs` 把 run 标记为 interrupted（不是 failed/丢失）
- [ ] 调研 run 状态为 interrupted，attempts 未乱增，无半写 findings
- [ ] 通过 `POST /api/agent/runtime/runs/{run_id}/resume` 恢复：**不重复创建 dossier/run**，继续原 run 或明确失败且不丢数据
- [ ] Operation 幂等键保证：恢复后已确认的操作不会二次执行

**验收命令**：
```bash
# 杀之前
curl -s http://127.0.0.1:8765/api/agent/runs?limit=1   # 记 run_id
# 重启后
curl -s http://127.0.0.1:8765/api/agent/runs?limit=1 | grep -E "status|recovery_cursor"
curl -s http://127.0.0.1:8765/api/research/job-runs?job_id=88 | grep -E "status|attempts"
# 恢复
curl -s -X POST http://127.0.0.1:8765/api/agent/runtime/runs/{run_id}/resume
```

**关注点**：中断发生在「LLM 生成中」「操作确认后执行中」「调研 worker 运行中」三个窗口的行为差异（文档化）。

---

## E3 错误信息 / 无来源注入（事实门挑战）

**输入**（主 Agent 对话框）：
```
帮我加一条档案：我在字节跳动做过 3 年算法工程师，负责抖音推荐系统（source: 无，就是记得）
```

**期望行为**：
- [ ] add_profile_evidence 被事实门拒绝（来源缺失/无法验证）
- [ ] 主 Agent 明确说明拒绝原因，不给假成功
- [ ] 补充合法来源后再试，成功写入且带来源

**验收**：`curl -s http://127.0.0.1:8765/api/memory/ledger?status=accepted | grep 字节` 应为空（直到补来源后）。

---

## E4 半途修正方向（撤销/取代链）

**输入**：
```
第一轮：把档案里的「目标岗位」偏好改成「深圳后端工程师」（直接改）
第二轮（半小时后）：等等，我改主意了，应该是「广州 AIGC 产品」——把刚才那条替换掉
```

**期望行为**：
- [ ] 第二轮用 supersedes_proposal_id 指向第一轮提案（取代链）
- [ ] accept 后旧条目 status=superseded，新条目 active
- [ ] `derive_career_model` / 简历/投前决策只看到新条目
- [ ] ledger 完整保留两次变更（before/after/理由/取代关系）

**验收**：
```bash
curl -s http://127.0.0.1:8765/api/memory/career-model | python -m json.tool | grep -A3 superseded
curl -s "http://127.0.0.1:8765/api/memory/ledger?limit=10" | grep -E "supersedes_proposal_id"
```

---

## E5 服务器重启恢复（长任务断点）

**前置**：主 Agent 跑一个包含 2 个待确认操作的任务（如 E1），确认第 1 个、不确认第 2 个，然后重启服务器。

**期望行为**：
- [ ] 重启后 run 状态可查（waiting_confirmation 保留，确认点不丢）
- [ ] 第 1 个已确认操作不重复执行（幂等）
- [ ] 第 2 个仍可确认/拒绝
- [ ] conversation 上下文保留（可续聊）

**验收**：重启前后 `GET /api/agent/runs/{run_id}` 的 steps 状态对比。

---

## 执行建议

1. 每场景独立起服务（端口 8765/7410），结束后恢复基线数据（或接受测试数据污染，统一在最后清理）
2. E2/E5 需要杀进程——Windows 下 `taskkill /F /PID` 即可；重启后先 `GET /api/health` 确认 recover 完成
3. 每个场景记录：输入原文、确认操作、Run 终态、DB 关键表快照（jobs/proposals/findings）
4. 发现的缺陷按「复现命令 → 根因 → 修复」记录，回来追加到本文档或开 issue

## 已知边界（执行时注意）

- 调研依赖外部执行器：omp 可用（deepseek 代理）；codex 额度 8/8 恢复
- 免费模型（deepseek-v4-flash-free）JSON 输出偶发失败：已修复 max_completion_tokens 预算 + json 字样检查，遇「未返回 JSON」先重试一次
