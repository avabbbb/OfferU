import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentToolError, AgentToolErrorCard } from "./AgentToolErrorCard";
import { ToolExecutionList } from "./EmbeddedAgentStreamView";
import { parseToolError } from "@/lib/agentToolError";
import type { ToolExecutionState } from "@/lib/embeddedAgentStream";

afterEach(cleanup);

const readOnly = { ok: false, error: { code: "read_only", message: "沙箱是只读的", retryable: false, suggestedAction: "在设置里打开可写" } };
const transient = { ok: false, error: { code: "upstream_unavailable", message: "招聘网站没响应", retryable: true } };

describe("AgentToolErrorCard", () => {
  it("shows message, code label, retry state and suggested action, urgent tone for user-owned errors", () => {
    render(<AgentToolErrorCard error={parseToolError(readOnly)!} toolName="write_file" />);
    const card = screen.getByTestId("agent-tool-error");
    expect(card.getAttribute("data-tone")).toBe("urgent");
    expect(card.textContent).toContain("沙箱是只读的");
    expect(card.textContent).toContain("write_file");
    expect(screen.getByTestId("agent-tool-error-code").textContent).toBe("只读模式 · read_only");
    expect(screen.getByTestId("agent-tool-error-retry").textContent).toBe("不可重试");
    expect(screen.getByTestId("agent-tool-error-action").textContent).toBe("建议：在设置里打开可写");
    expect(card.textContent).not.toContain("{");
  });

  it("uses the neutral tone for agent-owned errors and marks retryable", () => {
    render(<AgentToolErrorCard error={parseToolError(transient)!} />);
    const card = screen.getByTestId("agent-tool-error");
    expect(card.getAttribute("data-tone")).toBeNull();
    expect(screen.getByTestId("agent-tool-error-retry").textContent).toBe("可重试");
    expect(screen.queryByTestId("agent-tool-error-action")).toBeNull();
  });
});

describe("AgentToolError", () => {
  it("falls back to a plain line without JSON when the error is unstructured", () => {
    render(<AgentToolError result="ERROR: 文件不存在" toolName="read_file" />);
    expect(screen.queryByTestId("agent-tool-error")).toBeNull();
    expect(screen.getByTestId("agent-tool-error-plain").textContent).toBe("read_file：文件不存在");
  });
});

describe("ToolExecutionList errors", () => {
  const executions: Record<string, ToolExecutionState> = {
    a: { id: "a", toolName: "list_jobs", status: "done", result: { ok: true } },
    b: { id: "b", toolName: "write_file", status: "error", result: { details: readOnly }, isError: true },
    c: { id: "c", toolName: "fetch_page", status: "error", result: "ERROR: 超时" },
  };

  it("shows error cards while the group is collapsed, and still once expanded", () => {
    render(<ToolExecutionList executions={executions} />);
    const summary = screen.getByRole("button");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByTestId("agent-tool-error")).toHaveLength(1);
    expect(screen.getByTestId("agent-tool-error-plain").textContent).toContain("超时");
    fireEvent.click(summary);
    expect(screen.getByRole("list", { name: "工具调用" })).toBeTruthy();
    expect(screen.getAllByTestId("agent-tool-error")).toHaveLength(1);
  });

  it("renders no error area when nothing failed", () => {
    render(<ToolExecutionList executions={{ a: executions.a }} />);
    expect(screen.queryByTestId("agent-tool-errors")).toBeNull();
  });
});
