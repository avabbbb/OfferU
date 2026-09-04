# OfferU Public Release — Capability Plugin Error Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

Capability Plugin 的 stderr 现在在失败消息和成功返回的诊断字段中都经过统一的邮箱、电话、凭据脱敏与 2,000 字符上限处理。插件仍然是非信任 Capability，退出码和能力标识保留用于诊断与重试，插件输出不会因此被改写。

## 边界

- 没有改变 Capability Plugin 的安装、发现、权限或 Operation Registry 流程。
- OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端仍固定为 `http://127.0.0.1:8765`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增 architecture contract 仍待执行，Public Release 继续为 `NOT_READY`。

