# OfferU Public Release — privacy hygiene control surface

日期：2026-09-02  
观察 checkout：当前工作树  
结论：`PARTIAL`

## Change

Settings 的本地数据安全卡现在增加隐私卫生区域：

- 只读取旧邮件正文记录数和字符数，不读取或展示正文；
- 明确说明结构化面试通知字段会保留；
- 清理按钮只在确有待处理记录时显示；
- 清理前必须在独立确认框输入“清理旧正文”；
- 清理结果通过 Registry 路由返回并刷新计数；
- 合成邮箱测试数据由独立的严格命名空间清理入口处理，不与岗位 Demo Reset 或真实旧正文清理混用。

## Authority boundary

新增网页路由：

```text
GET  /api/agent/data/privacy-hygiene
POST /api/agent/data/privacy-hygiene/scrub
```

两条路由都只通过 `_ui_operation_outputs()` 调用：

```text
get_privacy_hygiene_status
scrub_legacy_email_notification_bodies
```

UI 不直接写数据库，且 `user_confirmed=true` 只会由用户在确认框完成后提交。后端 Operation 仍保留确认门和审计边界。

## Release mapping

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| R51 Secrets exclusion | `NOT_VERIFIED` | 页面不展示正文，现有 privacy hygiene service 只返回计数；完整历史行、trace、日志和 artifact matrix 仍缺 |
| R98 Privacy disclosure | `NOT_VERIFIED` | Settings 现在提供可理解的维护入口；最终公开法律政策、retention 和历史数据决定仍缺 |
| R99 Consent | `NOT_VERIFIED` | 真实旧正文清理仍要求明确用户确认；完整真实 OAuth/媒体和最终 outcome policy 仍缺 |
| R103 Support diagnostics | `NOT_VERIFIED` | 隐私状态可从 Settings 看到，但完整支持人员 error_id matrix 仍缺 |

## Verification boundary

本轮新增了 `test_settings_privacy_routes_use_registry_boundary` 契约测试，但按 `AGENTS.md` 未在写入后执行测试、构建或语法检查。真实工作区中的 3 条旧正文没有被读取、输出、删除或迁移；是否清理仍由产品/隐私所有者决定。合成邮箱清理若关联正式时间线，后端会拒绝操作。

本切片没有启动 Edge、没有访问 `8080`、没有打开浏览器，也没有修改真实用户数据库。
