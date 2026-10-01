import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolExecutionList } from "./EmbeddedAgentStreamView";

describe("migrated tool execution view", () => {
  it("shows failure and progress while keeping raw tool payloads out of the DOM", () => {
    render(<ToolExecutionList executions={{
      first: { id: "first", toolName: "读取岗位", status: "error", result: { api_key: "canary-secret" } },
      next: { id: "next", toolName: "核对岗位", status: "running" },
    }} />);
    expect(screen.getByText("出错")).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.queryByText(/canary-secret/)).not.toBeInTheDocument();
  });
});
