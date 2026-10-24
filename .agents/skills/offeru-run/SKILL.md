---
name: offeru-run
description: 启动、连接、验证 OfferU（本地求职工作台）。用户说「跑起来 / 连上 OfferU / 让 Codex 帮我建档 / 导出简历」时用。只管运行；简历怎么写见 offeru skill。
---

# OfferU 运行

网页、内置 Agent、外部 Agent（Codex / Claude Code）读写同一份数据，全部走 11 个共享工具：overview search list get save delete undo changes read_file export_resume_pdf fetch_page。

## 1. 启动

```bash
cd backend
pip install -r requirements.txt   # 切分支后必须重装，否则导 PDF 缺 markdown-it-py
python -m app.entry start --no-browser
```

- 端口固定 8766；首次启动打印 `/#/pair/...` 配对链接，5 分钟内只能打开一次。
- 数据目录用 `OFFERU_DATA_DIR`。若 8766 已有实例，start 只说「已在运行」就退出，不会切数据目录：先停旧实例。
- 自检：`GET /api/health` 返回 200；`python -m app.entry tool overview '{}'` 1 秒内返回。

## 2. 内置 Agent

设置里配模型 key 后，先直接请求一次网关 `/models`，确认不是 401 再测 Agent。报「Skill 自动路由无响应」时先看服务端日志里的 `[LLM Error]`，多半是 key 失效。

## 3. 外部 Agent（MCP）

入口 `python -m app.entry mcp`（stdio），环境变量 `OFFERU_DATA_DIR`、`PYTHONPATH=<仓库>/backend`、`PYTHONIOENCODING=utf-8`。

Codex 无人值守（`codex exec`）必须打开工具批准，否则每次 MCP 调用都被静默取消，任务却 exit 0：

```toml
[mcp_servers.offeru]
command = "python"
args = ["-m", "app.entry", "mcp"]
default_tools_approval_mode = "approve"
startup_timeout_sec = 30

[mcp_servers.offeru.env]
OFFERU_DATA_DIR = "<数据目录>"
PYTHONPATH = "<仓库>/backend"
PYTHONIOENCODING = "utf-8"
```

不想改全局配置：`docs/agent-testing/scripts/run_codex.sh`（`-c` 覆盖 + `--ignore-user-config`）。

Claude Code（先 `/login`）：`claude -p --mcp-config mcp.json --strict-mcp-config --allowedTools 'mcp__offeru__*'`。

## 4. 每次 Agent 跑完都核对

1. `tool list '{"type":"memory"}'`：条数和 Agent 自报的对上。
2. `tool changes '{}'`：看 actor 和摘要。
3. `tool export_resume_pdf '{"id":N}'`：看页数、中文有无方块。
4. 写错就 `tool undo '{"change_id":N}'`；重复撤销会得到「这条改动已经撤销过了」。

## 5. 隐私红线

真实简历、`config.json`、数据目录、exports 里的 PDF、Agent events 日志都不进仓库。截图只用虚构数据（`scripts/seed_demo.py`），提交前跑 `scripts/pii_scan.sh`。
