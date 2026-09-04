# OfferU Public Release — artifact symlink guard

日期：2026-09-02  
结论：`NOT_VERIFIED`

## Scope

加强发布物 secret/canary 审计的文件边界。发布目录中的符号链接不能被当成普通文件跟随读取，否则审计可能读取扫描根目录之外的内容。

## Changes

- `backend/scripts/release/audit_artifacts.py` 现在拒绝符号链接作为审计根目录；根目录内部链接会生成 `symlink` finding，链接不会进入字节扫描和 `file_count`；
- 新增隔离 contract，要求根链接被拒绝、内部链接被报告，且外部目标文件内容不出现在 audit result 中。

## Verification boundary

按项目 `AGENTS.md`，本切片写入后没有运行测试、构建或语法检查，也没有启动 Edge、访问 `8080`、打开浏览器或修改真实用户数据库。远程 CI、正式签名 artifact 和完整发布安全矩阵仍未验证。
