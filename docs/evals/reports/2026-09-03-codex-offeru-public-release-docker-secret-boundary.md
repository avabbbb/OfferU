# OfferU Public Release — Docker secret boundary

日期：2026-09-03  
状态：静态实现完成，contract/Docker runner 待执行

## 目标

避免公开仓库的示例环境或 Docker Compose 提供可直接使用的固定数据库密码、默认签名密钥或其它可复制凭据。

## 变更

- `.env.example` 将 `DB_PASSWORD` 与 `SECRET_KEY` 保留为空，并明确要求使用者提供唯一随机值；
- `docker-compose.yml` 使用 Compose 必填变量语法，缺少任一值时在启动前失败，不再使用 `:-` 固定回退值；
- `DEVELOPMENT.md`、`SECURITY.md` 和状态交接文档明确记录该边界；
- 新增 `test_docker_examples_require_explicit_secrets` 静态 contract，检查公开示例不存在旧固定值和宽松回退。

## 端口边界

该切片不把模型端点当网页入口：OfferU 网页仍是 `http://127.0.0.1:7410`，后端是 `http://127.0.0.1:8765`；8080 仅为可选 llama.cpp 模型接口。本轮没有启动 Edge、没有创建浏览器窗口、没有访问 8080，也没有修改真实数据库。

## 尚未执行

按 `AGENTS.md` 本轮没有运行测试、语法检查、构建或 Docker runner。正式 Public Release 仍需远程 CI、clean-machine、迁移、签名、隐私/安全和 live Provider 证据；该静态边界不能单独提升 Public Release verdict。
