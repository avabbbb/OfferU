# OfferU Public Release — Resume export error redaction

日期：2026-09-03  
状态：静态实现完成，contract/PDF runner 待执行

## 目标

Resume 导出在主渲染器和备用渲染器同时失败时，向用户提供可理解的失败信息，同时避免暴露本机路径、依赖堆栈或其它内部异常细节。

## 变更

- `backend/app/services/resume_export.py` 统一使用 `safe_error_message` 处理 Playwright 与 WeasyPrint 异常；
- 继续保留异常链供进程内部诊断，但用户可见文本不再直接拼接原始异常对象；
- 新增 release architecture contract，拒绝恢复旧的原始 renderer error 拼接。

## 端口与浏览器边界

该切片不启动 Playwright、Edge 或其它浏览器，不访问 8080；OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端仍固定为 `http://127.0.0.1:8765`。PDF 正式渲染仍需在后续授权验收中使用受控的 managed Chromium 无头路径或已批准的备用渲染器验证。

## 尚未执行

按 `AGENTS.md` 本轮没有运行测试、语法检查、构建、PDF 渲染或远程 runner。Public Release 仍需完整 PDF fixture、clean-machine、签名、升级、隐私/安全与 live Provider 证据。
