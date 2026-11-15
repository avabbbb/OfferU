import { describe, expect, it } from "vitest";
import { agentOrbLabel, agentOrbState } from "./agentWorkingOrb";

describe("agentOrbState", () => {
  it.each([
    ["正在思考...", "breathing"],
    ["助手正在调用 OfferU 工具...", "working"],
    ["工具运行中 · jobs.list 3s", "working"],
    ["助手已就绪，正在处理当前任务...", "working"],
    ["有一步不可撤销，已放进待确认列表；助手继续做别的...", "working"],
    ["正在读取：jobs.list", "searching"],
    ["正在检索岗位", "searching"],
    ["正在规划下一步", "solving"],
    ["正在生成回复", "composing"],
    ["正在发送...", "connecting"],
    ["正在启动外部执行器", "connecting"],
    ["正在恢复同一外部会话", "connecting"],
    ["正在从已保存的 Agent 会话恢复任务...", "connecting"],
    ["连接中断，正在按事件游标恢复同一个 Run...", "connecting"],
    ["模型调用正在安全重试...", "connecting"],
    ["Provider 正在重试", "connecting"],
    ["助手需要你的回答后继续...", "listening"],
    ["正在压缩本 Run 的模型上下文...", "shaping"],
    ["正在取消当前 Run...", "breathing"],
  ])("%s → %s", (label, state) => {
    expect(agentOrbState(label)).toBe(state);
  });

  it("falls back to context when the copy names no phase", () => {
    expect(agentOrbState("", { streaming: true })).toBe("composing");
    expect(agentOrbState("进行中", { toolRunning: true })).toBe("working");
    expect(agentOrbState(undefined)).toBe("breathing");
  });

  it("lets explicit copy win over context", () => {
    expect(agentOrbState("正在读取：resume", { streaming: true })).toBe("searching");
  });
});

describe("agentOrbLabel", () => {
  it("strips trailing ellipses and defaults to 正在思考", () => {
    expect(agentOrbLabel("正在思考...")).toBe("正在思考");
    expect(agentOrbLabel("正在读取：jobs.list…")).toBe("正在读取：jobs.list");
    expect(agentOrbLabel("Provider 正在重试。")).toBe("Provider 正在重试");
    expect(agentOrbLabel("  ")).toBe("正在思考");
    expect(agentOrbLabel(null)).toBe("正在思考");
  });
});
