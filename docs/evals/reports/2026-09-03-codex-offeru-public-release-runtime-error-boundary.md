# OfferU Public Release — Agent Runtime Error Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

Codex turn failure、Claude SDK worker failure 和非 hosted coding-agent worker 的 stderr 现在统一经过有界脱敏后再返回上层。错误仍会保留足够的状态/退出码用于重试和诊断，但不再直接传播外部进程输出中的凭据、邮箱、电话或完整超长错误正文。

## 边界

- 没有改变 AgentRuntimeProvider、Provider 选择或 Operation Registry。
- OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端仍固定为 `http://127.0.0.1:8765`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增 architecture contract 仍待执行，Public Release 继续为 `NOT_READY`。

