export const OFFERU_SKILL_DOWNLOAD_URL = "https://raw.githubusercontent.com/avabbbb/OfferU/main/.agents/skills/offeru/SKILL.md";

export const OFFERU_CONNECT_PROMPT = [
  "请接入这台电脑上正在运行的 OfferU。",
  `从 ${OFFERU_SKILL_DOWNLOAD_URL} 下载官方 OfferU Skill，并按 Skill 中与你当前 Agent 匹配的说明安装；只写入 OfferU Skill 文件，不改 Agent 的其他设置、账号、模型、凭据或代理。`,
  "随后按 Skill 检查本机 OfferU 是否可用；选择 connection_bootstrap Skill，查看 get_current_view 的 schema，并只通过对应的只读 Operation 读取当前同步页面和显式选中对象。把实际读取结果和连接状态告诉我，然后停止等待我的任务。若本机运行时不可用，明确报告尚未连接，不要猜路径。",
  "不要读取其他职业数据。GitHub URL 只用于获取公开 Skill；之后所有业务操作必须走同一 Operation Registry，所有写操作都留在 OfferU 等我确认，不得自行批准、提交、发送或联系第三方。",
].join("\n\n");
