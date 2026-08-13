

<p align="center">
  <img src="./asset/logo.png" width="112" alt="OfferU logo" />
</p>

<h1 align="center">OfferU</h1>

<p align="center">
  <strong>本地优先、证据驱动的 AI 求职工作台</strong><br />
  用一份经过确认的职业档案，连接岗位判断、材料定制、投递进展、面试训练和可审计 Agent。
</p>

<p align="center">
  <a href="https://github.com/avabbbb/OfferU/stargazers"><img src="https://img.shields.io/github/stars/avabbbb/OfferU?style=flat&logo=github" alt="GitHub stars" /></a>
  <a href="https://github.com/avabbbb/OfferU/issues"><img src="https://img.shields.io/github/issues/avabbbb/OfferU?style=flat" alt="GitHub issues" /></a>
  <img src="https://img.shields.io/badge/status-internal%20alpha-D97706?style=flat" alt="Internal alpha" />
  <img src="https://img.shields.io/badge/eval-baseline%20pending-64748B?style=flat" alt="Eval baseline pending" />
  <img src="https://img.shields.io/badge/license-MIT-2F855A?style=flat" alt="MIT License" />
</p>

<p align="center">
  <a href="./README_EN.md">English</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#第一次安全试跑">安全试跑</a> ·
  <a href="#给外部编程-agent-使用">Agent 接入</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#eval-与测试">Eval</a>
</p>

> [!IMPORTANT]
> OfferU 目前是本地单人内部 Alpha，不是已经通过发布验收的自动投递产品。它不会自动提交申请、发送邮件或联系第三方；Agent 的推断、材料和进展更新都必须先成为候选或提案，再由使用者审核确认。

<table>
  <tr>
    <td width="50%"><img src="./asset/screenshots/agent-workbench.png" alt="OfferU Agent 工作台" /></td>
    <td width="50%"><img src="./asset/screenshots/job-research-handback.png" alt="岗位研究证据审核" /></td>
  </tr>
  <tr>
    <td align="center"><strong>任务内 Agent Run、事件与确认</strong></td>
    <td align="center"><strong>候选结论、来源与未知项审核</strong></td>
  </tr>
</table>

## OfferU 是什么

OfferU 把求职过程收拢成五个连续阶段：

1. **今天**：查看当前最值得处理的行动、待确认信号和 Agent 任务。
2. **机会**：保存岗位、核对 JD、研究公司并判断是否值得投。
3. **材料**：维护基础简历，用已确认事实生成岗位定制提案。
4. **进展**：记录一次真实申请尝试、阶段变化、邮件信号和后续行动。
5. **面试**：准备问题、练习回答，并把反馈保留为学习观察。

OfferU 不使用公开 CSV 充当产品数据库，也不需要单独启动静态看板。前端工作台通过本地 FastAPI 读取 SQLite 数据；Agent 和其他自动化入口的业务写入必须经过 Operation Registry、授权、提案、确认和审计边界。

## 快速开始

### 0. 准备环境

当前主要开发与试用环境是 Windows：

- Git
- Python 3.12
- Node.js **22.19 或更高版本**，以及 npm
- Rust/Tauri toolchain（仅运行桌面壳时需要）

下载 ZIP 后解压，或者克隆仓库：

```powershell
git clone https://github.com/avabbbb/OfferU.git
Set-Location OfferU
```

也可以把仓库地址发给能读取本地文件的编程 Agent，让它先阅读 `AGENTS.md`，再按照下面的步骤安装。不要把 API Key、简历正文或其他隐私直接粘贴到公开会话。

### 1. 安装依赖

在仓库根目录运行：

```powershell
py -3.12 -m venv backend\.venv312
backend\.venv312\Scripts\python.exe -m pip install --upgrade pip
backend\.venv312\Scripts\python.exe -m pip install -r backend\requirements.txt

npm --prefix agent-runtime ci
npm --prefix frontend ci

if (-not (Test-Path backend\.env)) {
  Copy-Item .env.example backend\.env
}
```

`backend/.env` 只是本地配置副本，不包含可用的模型凭据。OfferU 的界面可以先启动，但需要模型的功能会在 provider 未配置时明确失败。启动后可在“设置”页配置连接；当前模型连接会写入被 `.gitignore` 排除的本地 `backend/config.json`，不要把“页面中已脱敏显示”误认为“磁盘上已经加密”。

### 2. 启动浏览器开发版

终端 A：

```powershell
backend\.venv312\Scripts\python.exe backend\run_server.py
```

终端 B：

```powershell
npm --prefix frontend run dev
```

打开 [http://localhost:7410](http://localhost:7410)。后端固定使用 `127.0.0.1:8765`，前端固定使用 `7410`。

如果浏览器出现 `Failed to fetch` 或 CORS 报错，先检查 Windows 用户环境变量 `CORS_ORIGINS` 是否仍是旧端口；系统环境变量的优先级高于 `backend/.env`。

### 3. 可选：启动桌面版

完成上面的依赖安装，并安装 Rust/Tauri toolchain 后，在仓库根目录运行：

```powershell
npm --prefix frontend run tauri -- dev
```

开发态桌面壳会启动自己的 Vite 与 Python 后端，不要同时保留第 2 步的两个进程，否则会发生端口冲突。

## 第一次安全试跑

第一次不要急着接触真实投递表单。建议先用测试数据或去除高度敏感字段的材料，走一遍只读闭环：

1. 在“设置”中配置一个可用模型连接。
2. 在首次引导或“档案/简历”中导入 **DOCX 或文本型 PDF**；可编辑 DOCX 更适合后续修改，扫描 PDF 可能需要额外 OCR 环境。
3. 逐条检查系统提取出的候选事实。学历、经历、技能和工作资格不能靠模型猜测。
4. 在“机会”中选中一条已有或测试岗位，打开右侧 OfferU Agent。
5. 询问：`这个岗位值得投吗？请列出证据、未知项和风险，先不要执行任何写入。`
6. 检查回答是否使用了当前岗位与已确认档案，是否把不知道的内容明确标为未知。
7. 如果只是试跑，不要确认任何写入提案，也不要进入真实申请页面。

> [!NOTE]
> 当前 live Skill Registry 仍可能把部分能力标记为 `partial`。自动找岗、浏览器表单识别与填充不能因为页面或接口存在就视为已经验收；以实时 manifest 和最新 Eval 报告为准。

## 给外部编程 Agent 使用

Claude Code、Codex CLI 或其他本地 Agent 不应复制 OfferU 的业务逻辑、直接改 SQLite，或自己拼接隐藏 HTTP 请求。先让它读取仓库约束和 OfferU Skill：

```text
先阅读 AGENTS.md 和 .agents/skills/offeru/SKILL.md。
从 backend/.venv312 启动，只做 doctor、manifest 和 agent_playbook。
先报告实时能力、partial 项和安全边界；不要执行 mutation，
不要提交申请，不要发邮件，也不要联系任何第三方。
```

也可以手动执行只读能力发现：

```powershell
Set-Location backend
.\.venv312\Scripts\python.exe -m app.cli doctor --pretty
.\.venv312\Scripts\python.exe -m app.cli manifest --pretty
.\.venv312\Scripts\python.exe -m app.cli agent_playbook --pretty
.\.venv312\Scripts\python.exe -m app.cli ops --pretty
```

需要调用某个 Operation 时，先读取它的 schema，再做 dry-run。不要把 README 里可能漂移的 Operation 数量、Skill 数量、provider 或模型名当成实时事实。

### 可选：给外部 Agent 配浏览器能力

只做 OfferU 本地界面、岗位研究或材料草拟时，不要求安装 Playwright MCP。只有当外部 Agent 需要真实打开网页、点击、输入、上传文件或截图时，才需要浏览器自动化。

Claude Code：

```powershell
claude mcp add playwright npx '@playwright/mcp@latest'
```

Codex CLI：

```powershell
codex mcp add playwright -- npx -y @playwright/mcp@latest
codex mcp list
```

安装后重新打开对应 Agent 会话。具体配置以 [OpenAI Codex MCP 文档](https://developers.openai.com/codex/mcp/) 和 [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) 为准。

> [!WARNING]
> 给 Claude/Codex 安装 Playwright MCP，只是给那个**外部 Agent 宿主**增加浏览器工具，不会自动把工具注入 OfferU 内置 Agent，也不会扩大 OfferU Registry 的权限。当前 OfferU 不应被描述为已经可以自主填写并提交所有招聘网站。

## 正式使用时的建议流程

```text
确认职业事实
  → 选中当前岗位
  → 获取带来源、未知项和风险的投前判断
  → 使用者决定投 / 有条件投 / 不投
  → 基于已验证事实生成材料提案
  → 使用者审核并自行处理真实表单
  → 记录一次申请尝试与阶段事件
  → 邮件或 Agent 信号先成为候选进展
  → 使用者确认后更新正式状态
```

一次只处理一个岗位更容易审计。收藏、加入岗位池、生成材料或打开申请页，都不等于“已投递”；只有真实提交成功并留下可核对记录后，才应更新为已提交。

## 安全边界

Agent 不应该：

- 猜测身份、学历、工作资格、薪资、签证或其他法律相关事实。
- 编造经历、项目、技能、作品集内容或岗位研究来源。
- 把网页文本、邮件、面试反馈或模型推断直接写成职业事实。
- 绕过验证码、Cloudflare、反爬机制、二次验证或未知账号登录。
- 把“收藏”“已追踪”“已打开表单”误记为“已投递”。
- 绕过 Operation Registry、dry-run、确认、审计或数据授权。
- 在没有使用者明确确认的情况下点击最终提交、发邮件或联系第三方。

如果自动化遇到验证码、登录、法律声明、薪资、工作资格或最终提交按钮，应停止并把控制权交还给使用者。

## 隐私说明

OfferU 是本地优先应用，但“本地优先”不等于“所有数据已经加密且绝不离开电脑”：

- 职业档案、岗位和进展主要保存在本地 SQLite；不要假设当前数据库已经完成静态加密，请保护 Windows 账户与磁盘。
- 模型连接从设置页保存后目前会写入本地 `backend/config.json`；接口返回时会脱敏，但不能据此假设磁盘内容已加密。邮件等支持的连接凭据使用操作系统 keyring。
- 不要提交 `backend/.env`、`backend/config.json`、数据库、上传文件或真实个人材料；同时保护 Windows 账户和磁盘。
- 使用云模型、网页研究、邮件或其他外部连接时，经过授权的数据可能发送给相应服务商。启用前先核对 provider 与数据范围。
- 不要把填有真实个人信息的仓库 fork、截图、日志或 Eval 报告公开发布；报告必须先脱敏。
- 如果只是体验项目，优先使用合成数据或删去身份证件、家庭住址等不必要字段的副本。

`.gitignore` 只是最后一道防误提交措施，不是隐私保险箱。个人材料最好保存在仓库外，再通过 OfferU 的导入入口选择文件。

## 当前状态与已知限制

| 项目 | 当前结论 |
|---|---|
| 开发阶段 | 本地单人内部 Alpha |
| 正式 Eval baseline | 尚无符合 `offeru-core-v1` 的当前有效 baseline |
| Operation / Skill 控制面 | 已有实现和局部证据，仍需持续做 live contract 验收 |
| 内置主 Agent | 已有运行链路，但不能仅凭页面可见或单次回答宣称完整可用 |
| 自动找岗与浏览器填表 | 当前按未完整验收处理；以 live manifest 的 `partial` 标记为准 |
| 自动提交 / 自动发信 | 明确不提供；必须保留人工最终控制 |
| 发布就绪度 | 未证明，不应宣传为无人值守求职机器人 |

历史评估只提供复现线索，不证明当前版本已经通过。查看 [docs/evals/reports](./docs/evals/reports/README.md) 获取报告状态和证据等级。

## Eval 与测试

任何“可用”“Agent 完整”“适合内测”的结论，都应来自真实任务、隔离 fixtures、轨迹与结果 grader、失败可见性和人工复核，而不是只看静态代码或构建成功。

推荐入口：

- [Eval 方法、Loop 与验收规则](./docs/evals/README.md)
- [OfferU Core v1 任务集](./docs/evals/offeru-core-v1.md)
- [给 DeepSeek 的 Loop Eval 与测试报告指导书](./docs/evals/deepseek-loop-eval-guide.md)
- [可直接粘贴给 DeepSeek 的完整深测提示词](./docs/evals/deepseek-deep-test-prompt.md)
- [DeepSeek IDE/CLI 实测手册](./docs/evals/deepseek-runbook.md)
- [机器可读报告 Schema](./docs/evals/report-schema.json)

开发者可按需手动运行：

```powershell
Set-Location backend
.\.venv312\Scripts\python.exe -m pytest tests -q

Set-Location ..
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

浏览器或 Agent E2E 需要另外准备真实运行环境和授权，不能由上述命令的绿色结果替代。

## 文档与仓库结构

```text
OFFERU/
├─ backend/                  FastAPI、领域服务、Registry、Agent Run Host
├─ frontend/                 React + Vite + Tauri 工作台
├─ agent-runtime/            Pi SDK worker/runtime bridge
├─ extension/                岗位采集浏览器插件（WXT）
├─ .agents/skills/offeru/    外部 Agent 的 OfferU Skill
├─ docs/
│  ├─ architecture/          当前架构合同
│  ├─ adr/                   架构决策记录
│  ├─ evals/                 suite、runbook、schema 与 reports
│  └─ agents/                Issue、triage 与 domain 规则
├─ CONTEXT.md                领域语言与产品边界
└─ AGENTS.md                 Agent 开发约束
```

从 [docs/README.md](./docs/README.md) 进入完整文档；归档内容和旧截图不证明当前能力。

## License

[MIT](./LICENSE)
