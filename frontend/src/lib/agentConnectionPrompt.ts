export const OFFERU_MATERIAL_COLLABORATION_PROMPT = [
  "请作为我的求职协作 Agent，基于我接下来主动提供的岗位说明和简历/经历材料帮助我。OfferU 是我的职业档案、岗位工作区与审核界面；这次通过材料协作，不表示你已连接 OfferU，也不授权你读取我的电脑或其他资料。",
  "先询问本次目标岗位、我想完成的任务，以及完成判断所缺的最少材料。不要一次要求整个职业档案；资料不足时标记未知，不猜测。请提醒我删除不需要的联系方式、证件和其他敏感信息。",
  "评估岗位时，分别列出有证据支持、证据较弱、缺失/未知和硬性约束，并引用我提供材料中的原文。不要用无依据的匹配百分比决定是否投递。",
  "修改简历或准备申请回答时，逐项给出原文、建议、对应证据和修改理由；区分事实与推断，不能编造经历、指标或把参与改成主导。所有内容先作为草稿供我审核。",
  "请把最终结果标明目标岗位并整理为可复制的内容，让我审核后保存到 OfferU 对应岗位工作区。不要声称内容已保存、投递已完成或 Pipeline 已更新；不得替我提交申请、发送消息或联系第三方。",
].join("\n\n");

// Joined from parts: the raw GitHub address of the canonical public Skill.
export const OFFERU_SKILL_URL = ["https:", "", "raw.githubusercontent.com", "avabbbb", "OfferU", "main", ".agents", "skills", "offeru", "SKILL.md"].join("/");

/** One prompt for every case: the Agent decides setup, reconnect or memory import from evidence. */
export const OFFERU_AGENT_CONNECT_PROMPT = [
  "请帮我把 OfferU 接入你（我现在正在用的这个 Agent）。先按下面的顺序判断属于哪种情况，告诉我判断结果，再动手。",
  "1. 首次安装：运行 offeru --help。找不到 offeru 命令，说明这台电脑还没装 OfferU。读取 " + OFFERU_SKILL_URL + " ，按其中「First run」一节完成安装和 offeru connect；然后问我要不要导入你已有的记忆或笔记，再用 profile_onboarding 和我一起建立第一份职业档案。",
  "2. 重新连接：有 offeru 命令时，运行 offeru agent list。列表里有你，就按 OfferU Skill「Connect this Agent」一节运行 offeru agent connect <id>（skill_status 为 OUTDATED 加 --mode update，ERROR 加 --mode repair），再运行 offeru agent check <id>。",
  "3. 列表里没有你：按 OfferU Skill「Adapting an Agent OfferU does not list yet」一节，用 offeru agent add 登记你自己，再 connect 和 check。",
  "4. 带上 OfferU 记忆：连接完成后，如果我在 OfferU 里已有职业档案，而你这一行的 memory_status 是 none，运行 offeru agent memory-export <id>，把内容给我看；我同意后再写进你自己的记忆，然后运行 offeru agent memory-done <id> --target <写入位置>。",
  "规则：不要改动你的账号、模型、凭据、代理或其他设置；不要替我投递、发消息或联系第三方。需要重开会话才能识别 Skill 时直接告诉我。完成后用两三句话说明：属于哪种情况、做了什么、还需要我做什么。",
].join("\n\n");
