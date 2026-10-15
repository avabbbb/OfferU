// =============================================
// Agent 快捷动作（docs/02 H-1：不硬编码）
// 按职业阶段生成，社招用户不再看到「校招体检」。
// 后续可接入目标岗位、当前实体和投递状态；保持纯函数便于测试。
// =============================================

export type CareerStage = "campus" | "experienced" | "unknown" | string;

export interface QuickAction {
  label: string;
  skillId: string;
  prompt: string;
}

const IDENTIFY_STAGE: QuickAction = {
  label: "确认身份",
  skillId: "profile_onboarding",
  prompt: "先问我几个问题，判断我是校招/应届/实习，还是社招/跳槽",
};

const HEALTH_CHECK: QuickAction = {
  label: "异常检测",
  skillId: "tracker",
  prompt: "检查我的档案、岗位库、投递进展和面试日程有没有异常",
};

const BY_STAGE: Record<"campus" | "experienced", QuickAction[]> = {
  campus: [
    {
      label: "校招体检",
      skillId: "market_calibration",
      prompt: "按校招标准检查我的档案、简历、岗位和投递流程缺口",
    },
    {
      label: "每日岗位",
      skillId: "evaluate_job",
      prompt: "今天给我推荐一个最值得投的校招/实习岗位，并说明为什么",
    },
  ],
  experienced: [
    {
      label: "跳槽体检",
      skillId: "market_calibration",
      prompt: "按社招标准检查我的档案、简历、目标岗位和投递流程缺口",
    },
    {
      label: "每日岗位",
      skillId: "evaluate_job",
      prompt: "今天给我推荐一个最值得投的社招岗位，并说明为什么",
    },
  ],
};

export function quickActionsForStage(stage: CareerStage | null | undefined): QuickAction[] {
  if (stage === "campus" || stage === "experienced") {
    return [...BY_STAGE[stage], HEALTH_CHECK];
  }
  // 阶段未知时只请求下一个最有用的前提（docs/02 §7 渐进引导）。
  return [IDENTIFY_STAGE, HEALTH_CHECK];
}
