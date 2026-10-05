export const MODEL_SETTINGS_ROUTE = "/settings?section=models";

export function agentRecovery(message: string) {
  if (/无法连接本地后端|Failed to fetch|NetworkError|本地服务|服务未启动/i.test(message)) {
    return { title: "OfferU 本地服务未连接", hint: "等待 Desktop 服务就绪后再试。你的任务内容已保留。", configure: false };
  }
  if (/API.?Key|LLM|模型|provider|401|403|认证|密钥|余额|quota|credit|billing|balance|model.not.found/i.test(message)) {
    return { title: "内置 Agent 的模型连接需要处理", hint: "检查模型配置、密钥或账户额度，测试连接成功后再发送。", configure: true };
  }
  if (/timeout|超时|rate.limit|429|限流/i.test(message)) {
    return { title: "模型服务暂时不可用", hint: "稍后再试，或在模型配置中切换服务。任务不会自动重复执行。", configure: true };
  }
  return { title: "本次任务未完成", hint: "查看错误原因后再试；已保存的任务和操作记录会保留。", configure: false };
}
