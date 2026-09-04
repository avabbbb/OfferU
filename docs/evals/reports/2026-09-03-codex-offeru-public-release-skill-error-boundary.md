# OfferU Public Release — Skill Error Boundary

日期：2026-09-03

## 结论

Skill Pipeline 的异常会进入 Agent 聚合结果，因此不能直接把原始 exception 文本作为 `error` 返回。现在统一经过 `safe_error_message`，在进入 Agent/UI 可见结果前完成长度限制、凭据脱敏和常见 PII 脱敏。

## 修改

- `backend/app/agents/skills/__init__.py` 的 Skill 失败结果改用共享 `safe_error_message`；
- 增加 release architecture contract，防止回退到 `str(e)`；
- 没有改变 Skill 执行顺序、业务结果或错误分类；
- 没有启动 Edge、打开浏览器或访问 `8080`。OfferU 网页入口仍固定为 `http://127.0.0.1:7410`，后端为 `http://127.0.0.1:8765`。

## 验证状态

已完成源码和 contract 写入；按仓库 `AGENTS.md` 本轮未执行测试、构建、语法检查或浏览器验收。新增 contract 需要后续由用户在授权环境执行。

Public Release 仍为 `OFFERU_PUBLIC_RELEASE_NOT_READY`。
