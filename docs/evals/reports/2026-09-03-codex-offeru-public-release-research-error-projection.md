# OfferU Public Release — Research Error Projection Boundary

日期：2026-09-03

## 结论

Role Intelligence 的读取投影现在会对历史 `RoleBenchmarkRun.error` 做二次安全处理。即使旧记录是在更早版本写入、没有经过当前写入边界，API 的 `last_error` 也不会直接返回原始异常文本。研究驱动器的任务异常输出同样使用共享脱敏边界。

## 修改

- `role_intelligence._run_summary` 保留原始错误仅用于内部状态分类，返回值使用 `safe_error_message`；
- `run_research_driver.py` 的 `TASK_EXC` 输出使用 bounded redaction；
- 新增 release architecture contract，防止恢复到直接输出原始错误；
- 未改变 Provider 状态判断、任务状态或研究结果；
- 没有启动 Edge、打开浏览器或访问 `8080`。网页入口仍为 `http://127.0.0.1:7410`，后端仍为 `http://127.0.0.1:8765`。

## 验证状态

源码和 contract 已写入；按 `AGENTS.md` 本轮未执行测试、构建、语法检查或浏览器验收。Public Release 仍为 `OFFERU_PUBLIC_RELEASE_NOT_READY`。
