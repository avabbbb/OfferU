# OfferU Public Release — Pi Guardian Error Boundary

日期：2026-09-03  
状态：`PARTIAL`

## 变更

Pi Agent Guardian 失败现在先通过 `safe_error_message` 生成单一的有界脱敏文本，再写入 `learning_observation` 和 `guardian.failed` 事件。这样持久化事件和实时发布使用同一错误投影，不会一侧脱敏、一侧保留原始异常。

## 边界

- 没有改变 Guardian 判定、Agent Run 状态或 Learning Candidate 语义。
- OfferU 网页仍固定为 `http://127.0.0.1:7410`，后端仍固定为 `http://127.0.0.1:8765`。
- 没有访问 `8080`，没有启动 Edge，也没有创建浏览器窗口。

## 未执行

按照 `AGENTS.md`，本切片未运行测试、构建、语法检查或浏览器验收；新增 architecture contract 仍待执行，Public Release 继续为 `NOT_READY`。

