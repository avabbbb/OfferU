# OfferU Internal Beta 快速开始

这份说明面向第一次接触 OfferU 的内测用户。OfferU 是本地优先的求职工作台：你建立 Profile、保存目标岗位，系统会把岗位研究、材料候选、投递进展和面试训练归档到同一个岗位上下文里。

## 1. 启动

要求 Windows、Python 3.12、Node.js 22+。首次安装依赖：

```powershell
Set-Location <OfferU>
backend\.venv312\Scripts\python.exe -m pip install -r backend\requirements.txt
npm --prefix frontend ci
```

终端 A 启动后端：

```powershell
Set-Location <OfferU>\backend
.\.venv312\Scripts\python.exe run_server.py
```

终端 B 启动前端：

```powershell
Set-Location <OfferU>
npm --prefix frontend run dev
```

打开 <http://localhost:7410>。后端为 <http://127.0.0.1:8765>。

启动检查：

```powershell
Set-Location <OfferU>\backend
.\.venv312\Scripts\python.exe -m app.cli doctor --pretty
```

如果浏览器出现 `Failed to fetch` 或 CORS 错误，先检查 Windows 用户环境变量 `CORS_ORIGINS`，确保包含 `http://localhost:7410,http://127.0.0.1:7410`；系统环境变量会覆盖 `backend/.env`。

## 2. 第一次使用

1. 在 Welcome 中选择“快速创建”或导入简历。
2. 按向导补充至少一条可核对的经历。
3. 进入“Opportunity”，点击“保存岗位”，粘贴职位描述。
4. 首次体验选择“本地准备（推荐）”。这是明确标记的 Replay/Fixture，不需要第三方登录。
5. 从岗位详情查看岗位情报、证据缺口、材料候选和专项面试。
6. 在 Today 查看系统已完成的工作和需要你决定的事项，在 Pipeline 查看岗位状态。

真实投递、真实邮件和外部平台操作不会由 OfferU 自动提交，必须由用户明确完成并审核回执。

## 3. 本地 Fixture / Replay

岗位保存时选择“本地准备（推荐）”即可启动可复现的本地链路。岗位详情中的 `Fixture`、`Replay`、合成公司和比较岗位都不代表实时市场数据。真实研究需要已验证的 Agent Provider；Provider 不可用时会显示 `Provider 被阻塞` 或失败原因，不会伪造成功。

若只想查看独立的展示数据，可使用 Showcase：

```powershell
$env:VITE_SHOWCASE = "true"
npm --prefix frontend run dev
```

Showcase 使用浏览器 IndexedDB 中的虚构数据，不连接后端；清除站点数据即可重置展示工作区。真实内测请使用正常后端模式。

## 4. 数据位置与备份

默认本地数据库是 `backend/offeru.db`。备份前停止后端，复制数据库文件到用户自己的安全位置：

```powershell
Set-Location <OfferU>
Copy-Item backend\offeru.db backups\offeru-$(Get-Date -Format yyyyMMdd-HHmmss).db
```

恢复时停止后端，确认目标数据库路径就是 `backend/offeru.db`，再把备份复制回去并重新启动。不要在后端运行期间覆盖 SQLite 文件。恢复前保留当前文件副本；这是一份本地单人 Beta，暂不提供云端恢复。

也可以在 Settings 的“本地数据安全”中点击“导出本地数据”，下载可读 JSON。导出包含核心职业状态、岗位、材料、面试和学习记录；Provider 密钥、邮箱凭据、分享密钥和浏览器会话会被排除或脱敏。它用于数据携带，不替代 SQLite 文件备份。

## 5. 遇到问题

优先查看 Today 的失败/阻塞任务和 Settings 的 Provider 状态。反馈时提供当前页面、操作步骤、时间和不含隐私的错误信息；不要粘贴 API Key、OAuth Token、完整邮件或完整简历。

更多验收路径见 [INTERNAL_BETA.md](./INTERNAL_BETA.md)。
