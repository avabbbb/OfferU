"use client";

// 工具报错卡片：错误说明、错误码、建议操作、能不能重试；不露 JSON 原文（lib/agentToolError）。
// 需要用户本人处理的（只读、权限、本机不支持）用橙色（紧急）；其余是 Agent 自己会处理的，中性色。

import { AlertTriangle, RotateCw } from "lucide-react";
import { parseToolError, plainToolErrorText, type ToolErrorView } from "@/lib/agentToolError";

export function AgentToolErrorCard({ error, toolName }: { error: ToolErrorView; toolName?: string }) {
  return (
    <div className="agent-tool-error" role="note" data-testid="agent-tool-error" data-tone={error.needsUser ? "urgent" : undefined}
      aria-label={`${toolName ? toolName + " " : ""}出错：${error.message}`}>
      <div className="agent-tool-error__head">
        <AlertTriangle size={13} aria-hidden className="agent-tool-error__icon" />
        <span className="agent-tool-error__message">{error.message}</span>
      </div>
      <div className="agent-tool-error__meta">
        {toolName && <span className="agent-tool-error__tool">{toolName}</span>}
        <span className="agent-tool-error__code" title={error.code} data-testid="agent-tool-error-code">{error.codeLabel}{error.codeLabel !== error.code ? ` · ${error.code}` : ""}</span>
        <span className="agent-tool-error__retry" data-retryable={error.retryable || undefined} data-testid="agent-tool-error-retry">
          {error.retryable ? <><RotateCw size={11} aria-hidden />可重试</> : "不可重试"}
        </span>
      </div>
      {error.suggestedAction && (
        <p className="agent-tool-error__action" data-testid="agent-tool-error-action">建议：{error.suggestedAction}</p>
      )}
    </div>
  );
}

/** 认得出结构化错误就画卡片，否则一句话（plainToolErrorText），都不露 JSON 原文。 */
export function AgentToolError({ result, toolName }: { result: unknown; toolName?: string }) {
  const error = parseToolError(result);
  if (error) return <AgentToolErrorCard error={error} toolName={toolName} />;
  return (
    <p className="agent-tool-error agent-tool-error--plain" role="note" data-testid="agent-tool-error-plain">
      <AlertTriangle size={13} aria-hidden className="agent-tool-error__icon" />
      <span className="agent-tool-error__message">{toolName ? toolName + "：" : ""}{plainToolErrorText(result)}</span>
    </p>
  );
}
