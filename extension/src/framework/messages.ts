// =============================================
// 扩展消息合同：Side Panel ↔ Background ↔ Page Agent
// 边界：Side Panel 不读 DOM；Page Agent 不直连后端；Background 不含业务判断。
// EXT-FRAME-001 只定义合同类型，不实现路由。
// =============================================

import type { ResolveOutcome } from "../rule-packs/contracts.js";
import type { ConnectionState } from "./offeru-control.js";
import type {
  FillPlan,
  FillResult,
  JobImportPlan,
  JobImportResult,
  SubmissionCandidate,
  SubmissionResult,
} from "./workflow.js";

export type ExtensionBusMessage =
  // 页面检测
  | { kind: "page:detect"; tabId: number; url: string }
  | { kind: "page:detection"; outcome: ResolveOutcome }
  // 岗位采集
  | { kind: "job:prepare-import"; url: string }
  | { kind: "job:import-plan"; plan: JobImportPlan }
  | { kind: "job:confirm-import"; planId: string }
  | { kind: "job:import-result"; result: JobImportResult }
  // 安全填表
  | { kind: "fill:prepare"; url: string; jobId: string }
  | { kind: "fill:plan"; plan: FillPlan }
  | { kind: "fill:confirm"; planId: string }
  | { kind: "fill:result"; result: FillResult }
  // 提交候选证据
  | { kind: "receipt:prepare"; url: string }
  | { kind: "receipt:candidate"; candidate: SubmissionCandidate }
  | { kind: "receipt:confirm"; candidateId: string }
  | { kind: "receipt:result"; result: SubmissionResult }
  // 后端连接状态
  | { kind: "control:state"; state: ConnectionState };
