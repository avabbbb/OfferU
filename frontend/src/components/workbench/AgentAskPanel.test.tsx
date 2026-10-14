import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInputRequestView } from "@/lib/decisionPlans";

const answerInputRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ agentRuntimeApi: { answerInputRequest } }));

import { AgentAskCard, initialSelection } from "./AgentAskPanel";

function makeRequest(overrides: Partial<AgentInputRequestView> = {}): AgentInputRequestView {
  return {
    request_id: "input_1",
    run_id: "run_1",
    status: "pending",
    question: "突出哪段经历？",
    options: [
      { option_id: "product", label: "产品经历", recommended: true },
      { option_id: "tech", label: "技术经历" },
      { option_id: "both", label: "都写" },
    ],
    allow_free_text: true,
    selection_mode: "single",
    min_selections: 0,
    max_selections: 1,
    allow_skip: true,
    ...overrides,
  };
}

describe("AgentAskCard (docs/02 §4.2)", () => {
  beforeEach(() => {
    answerInputRequest.mockReset();
    answerInputRequest.mockResolvedValue({ ok: true });
  });

  it("renders single-choice questions as radios with the recommendation preselected", async () => {
    const user = userEvent.setup();
    render(<AgentAskCard request={makeRequest()} runId="run_1" />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(radios[0]).toBeChecked();
    await user.click(screen.getByLabelText(/技术经历/));
    expect(radios[0]).not.toBeChecked();
    expect(radios[1]).toBeChecked();
    await user.click(screen.getByRole("button", { name: /提交回答/ }));
    expect(answerInputRequest).toHaveBeenCalledWith(
      "run_1",
      "input_1",
      expect.objectContaining({ selected_option_ids: ["tech"] }),
    );
  });

  it("caps multiple-choice at max_selections", async () => {
    const user = userEvent.setup();
    render(
      <AgentAskCard
        request={makeRequest({ selection_mode: "multiple", max_selections: 2 })}
        runId="run_1"
      />,
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0]).toBeChecked();
    await user.click(boxes[1]);
    expect(boxes[2]).toBeDisabled();
    expect(screen.getAllByText(/最多 2 项/).length).toBeGreaterThan(0);
  });

  it("always offers skip as an exit (D-3)", async () => {
    const user = userEvent.setup();
    render(<AgentAskCard request={makeRequest({ options: [] })} runId="run_1" />);
    await user.click(screen.getByRole("button", { name: /跳过/ }));
    expect(answerInputRequest).toHaveBeenCalledWith(
      "run_1",
      "input_1",
      expect.objectContaining({ skipped: true, selected_option_ids: [], free_text: "" }),
    );
  });

  it("hides skip when the agent marks the question as required", () => {
    render(<AgentAskCard request={makeRequest({ allow_skip: false })} runId="run_1" />);
    expect(screen.queryByRole("button", { name: /跳过/ })).toBeNull();
  });

  it("initialSelection keeps a single recommendation for single-choice", () => {
    const request = makeRequest({
      options: [
        { option_id: "a", label: "A", recommended: true },
        { option_id: "b", label: "B", recommended: true },
      ],
    });
    expect(initialSelection(request)).toEqual(["a"]);
    expect(initialSelection({ ...request, selection_mode: "multiple", max_selections: 0 })).toEqual(["a", "b"]);
  });
});
