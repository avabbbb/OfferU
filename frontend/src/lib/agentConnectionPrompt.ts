export const OFFERU_MATERIAL_COLLABORATION_PROMPT = [
  "请作为我的求职协作 Agent，基于我接下来主动提供的岗位说明和简历/经历材料帮助我。OfferU 是我的职业档案、岗位工作区与审核界面；这次通过材料协作，不表示你已连接 OfferU，也不授权你读取我的电脑或其他资料。",
  "先询问本次目标岗位、我想完成的任务，以及完成判断所缺的最少材料。不要一次要求整个职业档案；资料不足时标记未知，不猜测。请提醒我删除不需要的联系方式、证件和其他敏感信息。",
  "评估岗位时，分别列出有证据支持、证据较弱、缺失/未知和硬性约束，并引用我提供材料中的原文。不要用无依据的匹配百分比决定是否投递。",
  "修改简历或准备申请回答时，逐项给出原文、建议、对应证据和修改理由；区分事实与推断，不能编造经历、指标或把参与改成主导。所有内容先作为草稿供我审核。",
  "请把最终结果标明目标岗位并整理为可复制的内容，让我审核后保存到 OfferU 对应岗位工作区。不要声称内容已保存、投递已完成或 Pipeline 已更新；不得替我提交申请、发送消息或联系第三方。",
].join("\n\n");

// Joined from parts: the raw GitHub address of the canonical public Skill.
export const OFFERU_SKILL_URL = ["https:", "", "raw.githubusercontent.com", "avabbbb", "OfferU", "main", ".agents", "skills", "offeru", "SKILL.md"].join("/");

/** One prompt for every case: the Agent decides setup or reconnect from evidence. */
export const OFFERU_AGENT_CONNECT_PROMPT = [
  "请帮我把 OfferU 接入你（我现在正在用的这个 Agent）。先按下面的顺序判断属于哪种情况，告诉我判断结果，再动手。",
  "1. 首次安装：运行 offeru doctor。找不到 offeru 命令，说明这台电脑还没装 OfferU。读取 " + OFFERU_SKILL_URL + " ，按其中「首次使用」一节装好并运行 offeru start；然后用 overview 看我的现状，和我一起建立第一份职业档案。",
  "2. 已经装好：确认 OfferU Skill 已经装进你的 Skill 目录（工作台「设置 → 我的 Agent」点「连接」，或按 Skill「首次使用」第 4 步手动复制）。不需要注册 MCP，OfferU 只走命令行。然后运行一次 offeru tool overview，确认能读到数据。",
  "规则：不要改动你的账号、模型、凭据、代理或其他设置；不要替我投递、发消息或联系第三方。需要重开会话才能识别 Skill 时直接告诉我。完成后用两三句话说明：属于哪种情况、做了什么、还需要我做什么。",
].join("\n\n");

export const OFFERU_WEB_ORIGIN = "https://offeru.avabbbb.com";

/**
 * 网页版（local-web）的接入提示词：数据在用户浏览器的 IndexedDB 里，本机 `offeru start` 起的是另一份空数据，
 * 所以桥只能是用户自己的 S3 / R2 加密同步 + `offeru sync pair` 链接。用户只做登录 / 两步验证和输入口令。
 */
export function offeruWebAgentConnectPrompt(origin: string = OFFERU_WEB_ORIGIN): string {
  return [
    `请帮我把 OfferU 网页版（${origin}）里的数据接到你（我现在正在用的这个 Agent）这里。网页版的数据只存在我这台浏览器里，你在本机运行的 OfferU 看不到；唯一的桥是我自己的 S3 / R2 存储桶上的端到端加密同步。按下面的顺序做，每做完一步用一句话告诉我结果。`,
    `1. 装命令行：读取 ${OFFERU_SKILL_URL} ，按其中「首次使用」装好 offeru 命令，只需要命令行。不要运行 offeru start，也不要把本机工作台当数据源：那是一份和网页版无关的空数据。`,
    `2. 存储桶：问我有没有 S3 / R2 存储桶。没有就由你自己操作浏览器，在 Cloudflare 建一个 R2 存储桶（例如 offeru-sync）和一个只限这个桶的「Object Read & Write」API 令牌，并给这个桶加 CORS 规则：允许来源 ${origin}，方法 GET、PUT、HEAD、DELETE，请求头 authorization、content-type、x-amz-date、x-amz-content-sha256、if-match、if-none-match，暴露响应头 ETag。遇到登录密码、验证码、两步验证时只请我做这一步，其他都由你完成。`,
    `3. 设置同步：生成一个强同步口令（至少 20 位随机字符），只在对话里告诉我一次，请我自己记好（丢了数据就解不开）。然后运行 offeru sync configure --endpoint <Endpoint> --bucket <存储桶> --region auto --access-key-id <Access Key ID> --path-style，Secret 和口令只放在环境变量 OFFERU_SYNC_SECRET_ACCESS_KEY、OFFERU_SYNC_PASSPHRASE 里（或用标准输入传 JSON），不要写进命令行参数或文件。`,
    `4. 发链接：运行 offeru sync pair --web-origin ${origin}，把输出的链接原样发给我（30 分钟内有效，过期就重新运行）。我打开链接、输入同步口令就连上了。`,
    `5. 我说连好之后：运行 offeru sync now，再运行 offeru tool overview，确认读到的是我网页版里的岗位和档案。`,
    `6. 以后：开工前先运行 offeru sync now 拿最新数据；每次改动数据之后都再运行一次 offeru sync now，网页版才看得到。`,
    `规则：除了为这次同步新建的存储桶和令牌，不要改动你的账号、模型、凭据、代理或其他设置；不要替我投递、发消息或联系第三方。完成后用两三句话说明做了什么、还需要我做什么。`,
  ].join("\n\n");
}
