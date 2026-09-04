# Public Release Readiness Audit

日期：2026-09-02

## 结果

命令：

```text
backend\.venv312\Scripts\python.exe backend\scripts\release\audit_release_readiness.py --repo-root . --json
```

- 清单行数：114；预期：114
- 结构化审计 findings：0
- 不支持状态：0
- PASS：50
- NOT_VERIFIED：63
- BLOCKED_EXTERNAL：1（R90 代码签名证书）
- FAIL：0
- PRE_EXISTING_FAILURE：0
- 当前 verdict：`OFFERU_PUBLIC_RELEASE_NOT_READY`

`NOT_VERIFIED` 保留了已有证据但表示该 Gate 尚未被完整证明；不能把局部证据升级为 Public Release PASS。

## 本地运行时 URL

- `http://127.0.0.1:7410/`：HTTP 200，返回 OfferU 前端页面。
- `http://127.0.0.1:8765/api/health`：HTTP 200，返回 `status=ok`。
- `8080`：当前没有监听，不是 OfferU 网页地址；仓库中仅作为可选本地 llama.cpp Provider 的 `/v1/models` endpoint。
- 仓库根目录的 `OfferU.exe`：文件版本 `0.1.0`，二进制字符串仍包含旧的 `127.0.0.1:8000/docs` 和 `127.0.0.1:3300`；未运行该历史文件，本轮已将其可恢复地改名为 `OfferU-legacy-0.1.0.exe.disabled`，不把它作为当前 Release 入口。

## 浏览器安全边界

- 本次审计没有打开任何浏览器窗口。
- Playwright 验收统一使用隔离的 managed Chromium、`headless=true`。
- 自动化验收、PDF 和临时 debug 路径未发现调用系统 Edge、默认浏览器或 `headless:false`；`authorized_research.py` 的可见登录窗口是用户确认后才启动的外部授权流程，不属于自动验收。
- 原临时可见调试脚本 `.tmp/resume-blob-download-debug.cjs` 已改为无头模式。

## 仍需外部或独立环境证据

代码签名证书、历史 Release 安装包升级、真正 clean-machine/陌生用户验收、远程 CI runner、完整 live Provider/network/restart 矩阵，以及隐私/法律所有者决定仍不能由本地命令行审计伪造为通过。
