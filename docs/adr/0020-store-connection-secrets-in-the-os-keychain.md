---
status: accepted
---

# 邮箱连接密钥只存操作系统钥匙串

OfferU 使用 Windows Credential Manager、macOS Keychain 或 Linux Secret Service 保存邮箱 OAuth token、IMAP 应用密码和后续连接密钥。应用数据库只保存账号元数据、授权范围和不透明凭据引用；原始密钥不得写入 SQLite、配置文件、日志、遥测或 Agent 上下文。
