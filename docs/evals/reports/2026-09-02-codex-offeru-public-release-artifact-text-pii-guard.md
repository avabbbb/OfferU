# OfferU Public Release — Artifact Text PII Guard

日期：2026-09-02  
状态：静态实现完成，运行证据待执行

## 目标

让发布前、安装前和 Draft Release 前的 artifact audit 发现文本型诊断/日志/配置/说明文件中的邮箱地址和手机号，同时保持 value-free 输出。

## 变更

- `audit_artifacts.py` 对明确的文本扩展名扫描邮箱地址和手机号；
- 二进制 installer/sidecar 不套用文本 PII 规则，只继续扫描 secret/canary/private-key/token，避免随机二进制字节导致误报；
- findings 只包含相对路径和类别，不包含匹配值；
- 新增隔离 contract，验证文本 PII 会被发现、值不会进入审计结果，二进制同内容不会被文本 PII 规则报告。

## 验收映射

- GOAL：50–53、56–58、91–92；
- Release Checklist：R51、R53、R58、R91、R92；
- Security：release artifact、diagnostic/log PII boundary。

## 尚未执行

按 `AGENTS.md`，本轮没有运行测试、构建、语法检查、远程 runner 或浏览器。没有启动 Edge、没有访问 `8080`，也没有修改真实用户数据库。历史日志、第三方输出、完整 retention matrix 和签名 artifact 仍待后续真实验收，Security 与 Public Release 不能因该静态控制单独通过。
