# OfferU Public Release — Local Provider Discovery Error Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

本地模型自动发现保存配置失败时，错误现在通过 `safe_error_message` 返回，不再把原始文件路径、环境信息或异常正文直接暴露给 Settings/调用方。探测仍然是非阻塞的：本地模型端点（包括可选的 `127.0.0.1:8080` llama.cpp 接口）只作为模型 Provider 探测，不是 OfferU 网页入口。

## 边界

- OfferU 网页仍固定为 `http://127.0.0.1:7410`。
- OfferU 后端仍固定为 `http://127.0.0.1:8765`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增 architecture contract 仍待执行，Public Release 继续为 `NOT_READY`。

