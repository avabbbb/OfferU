> **已归档（2026-10）**：本文不再是当前权威。当前文档：历史证据，见 09-quality-and-release.md（位于 `docs/`）。

# 用户自带 Agent：接入实施方案与第一切片

日期：2026-09-30。覆盖已经使用通用 Agent、愿意投入求职质量的大学生、研究生和社招用户。覆盖目标用户不等于所有宿主自动直连已经实现。

## 当前实际实现

App-first 面板、全局入口和首次设置不再将用户限定为本地 Coding Agent。一个通用接入提示词先要求检查本机工具能力；可执行宿主沿用 canonical Skill→CLI→Operation 只读验证。不具备能力的宿主必须明确未连接，不得把其云端 localhost 当作用户电脑。

聊天用户可展开“材料协作”，复制求职协作说明，主动提供本次岗位和必要经历。说明要求 evidence-linked 建议、事实/推断区分、原文与修改理由；审核后由用户将采用的内容保存到对应岗位工作区。它不是直接连接、自动导出、结果导入器或 canonical AgentRun。复制材料说明不会改变本地接入提示词的状态。复制失败保留可选取文本。

没有新增 Agent runtime、Profile/Job 数据库、host picker、网络隧道、自动上传或后台模型调用。没有修改 production Career Truth。

## 为什么接入方式必须按宿主能力区分

| 路径 | 当前状态 | 实施方式 |
|---|---|---|
| 本地 Coding Agent | 复用已有 Skill/CLI/Bridge；逐宿主验证仍需实际验收 | 同一 Registry、最小 Skill surface、只读 bootstrap；连接成功与复制提示词分开 |
| 支持本地工具的消费级桌面宿主 | 下一切片候选，未在此次接入 | 复用现有 MCP/Operation projection，按宿主官方扩展格式打包；先证明只读回读，再做 Proposal |
| 仅能聊天/尚无 connector 的宿主 | 此次已提供材料协作入口 | 用户主动分享最少材料，审核并手动采用；明确没有连接 |
| 云端 connector Agent | 尚未实现；网络策略已询问用户，尚未获得答复 | 确定宿主、账号可用性和受限传输之后，逐一接入，不能默认暴露本地 Runtime |

官方资料核验：

- [ChatGPT Developer mode/MCP](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)：远程 MCP；不能直接连本地 server；可用性和写能力受账号/模式影响，Secure MCP Tunnel 是官方提供的受限连接方案之一。不能仅凭用户付费就认定所有模式都有写工具。
- [Claude 桌面与网页 connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)：remote connector 与 local extension 不同；使用面和宿主能力应逐项验证。
- [Muse 官方说明](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)：云端 VM、用户控制服务访问和审批。此资料不能证明 OfferU 已有可用 connector 或本地接入路径。

## 自动接入的实施顺序

1. 先修复全面评审中的 P1：完整交付、HTTP 写边界、dirty draft、CareerTask/Run 绑定、PII。此次没有顺手修复这些问题。
2. 本地消费级宿主的第一刀：选择一个实际可用宿主；复用 `backend/app/mcp_server.py` 的成熟 MCP SDK 与 Operation projection。审计并收窄现有全 Registry catalog/profile resource 的默认授权，初次配对只暴露 connection_bootstrap 的 get_current_view；不要直接把现有 `/mcp` 暴露给云端。
3. 验证真实宿主发出 model-issued 只读调用、返回 canonical 页面/岗位 refs、持久 Run/connection evidence；网络连接或安装完成本身不等于验收成功。
4. 第二刀才加入 scoped Job/Profile read 与 protected mutation。变化生成持久 Proposal，在 OfferU UI 独立确认；宿主不得取得 UI approval capability、批准自己的写操作或调用隐藏业务 shell。
5. 云端路径在用户确定网络边界后实施：优先宿主官方安全传输；授权必须包含宿主身份、明确 entity/operation scope、过期与撤销。仅有安全 tunnel 不等于有工具授权。沿用 Registry/HITL/审计，不做第二 backend 或 Career Truth 同步副本。
6. 材料协作若要减少人工搬运，再做独立纵向切片：用户选定 Job 与 evidence refs→预览明确分享内容→导出带来源/版本的 task packet→返回结构化 draft→校验→Proposal/HITL。导出和返回都经现有 Registry；不以聊天回复自动改 Career Truth。

## 修改范围与验收

- `frontend/src/lib/agentConnectionPrompt.ts`：能力检查及材料协作说明。
- `frontend/src/components/workbench/AgentConnectionPanel.tsx`：统一入口、材料协作和独立复制状态。
- `frontend/src/components/workbench/AgentConnectionPanel.test.tsx`：现有接入行为与材料复制/失败边界。
- `frontend/src/components/onboarding/OnboardingWizard.tsx`：首次设置同样覆盖聊天用户，不新增 onboarding 分叉。
- `docs/product/current-product.md`：受众与当前接入能力的真实范围。

验收映射：可复制本地接入说明；可复制材料说明；材料说明不标记连接、不读取数据；复制失败能手动选取；旧的页面同步错误保持独立。日志：`H:/tmp/offeru/agent-audience-20260930/`。

全部修改完成后，frontend typecheck PASS，接入面板/context 相关测试 8 PASS，git diff --check PASS。没有后端代码变更，因此未运行后端 pytest；没有依赖、构建配置或路由变更，因此未重复 production build。未做网页视觉、真实宿主连接、云端 tunnel 或模型验收，不声称这些能力已经打通。
