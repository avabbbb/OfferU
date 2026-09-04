# OfferU Public Release — Config Atomic Write

日期：2026-09-03  
状态：`PARTIAL`

## 本轮处理

- `backend/config.json` 的 Provider 配置写入统一先写同目录临时文件，再使用 `os.replace` 原子替换目标文件。
- Server route、Provider import 和本地模型发现共用同一个写入边界，避免进程中断时留下半个 JSON 并在启动时静默回退。
- 现有配置结构、密钥遮罩和运行时同步行为保持不变。

## 未完成

本轮按 `AGENTS.md` 未运行测试、语法检查、构建或浏览器验收；因此不能把配置恢复、全量数据安全或 Public Release 声明为通过。没有启动 Edge、创建浏览器窗口或访问 `8080`。
