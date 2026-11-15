/**
 * Agent 「正在做什么」→ Thinking Orbs 点阵球的状态（参考 Inspora 5-8 · Jakub Antalik「Thinking orbs」）。
 * 纯函数：只看进度文案和少量上下文，组件和测试共用。
 */
export type AgentOrbState =
  | "working"
  | "searching"
  | "solving"
  | "listening"
  | "connecting"
  | "weaving"
  | "composing"
  | "breathing"
  | "shaping";

export type AgentOrbContext = {
  /** 正文正在一段段流出来（assistant.delta），且文案没指明更具体的阶段。 */
  streaming?: boolean;
  /** 有工具正在运行，且文案没指明更具体的阶段。 */
  toolRunning?: boolean;
};

// 顺序即优先级：先认「等你」「重试 / 连接」，再认读 / 想 / 写 / 做，避免「模型调用正在重试」被当成调工具。
const RULES: Array<[RegExp, AgentOrbState]> = [
  [/需要你|等你|你的回答|等待用户|等待回答/, "listening"],
  [/重试|重连|连接|启动|恢复|会话|发送/, "connecting"],
  [/压缩|整理上下文/, "shaping"],
  [/读取|检索|搜索|查找|查询|搜一/, "searching"],
  [/规划|计划|解决|分析|比对|对比|推理/, "solving"],
  [/生成|撰写|写作|起草|回复/, "composing"],
  [/调用|工具|运行中|处理|执行|继续做/, "working"],
  [/思考|取消/, "breathing"],
];

/** 进度文案 → 点阵球状态；认不出时按上下文（正在出字 → composing，工具在跑 → working），否则「呼吸」。 */
export function agentOrbState(label: string | null | undefined, context: AgentOrbContext = {}): AgentOrbState {
  const text = (label || "").trim();
  for (const [pattern, state] of RULES) {
    if (pattern.test(text)) return state;
  }
  if (context.toolRunning) return "working";
  if (context.streaming) return "composing";
  return "breathing";
}

/** 胶囊上的文字：去掉结尾的省略号 / 句号，空了就是「正在思考」；省略号由组件统一补。 */
export function agentOrbLabel(label: string | null | undefined): string {
  const text = (label || "").trim().replace(/(?:\.{2,}|…+|。)+$/u, "").trim();
  return text || "正在思考";
}
