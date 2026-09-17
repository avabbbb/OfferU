import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockIngestJob } = vi.hoisted(() => ({
  mockIngestJob: vi.fn(),
}));

vi.mock("../../lib/hooks", () => ({
  ingestJob: mockIngestJob,
}));

vi.mock("../../lib/showcase/router", () => ({ SHOWCASE: false }));

import { AddJobModal } from "./AddJobModal";

function renderModal(props?: Partial<Parameters<typeof AddJobModal>[0]>) {
  const onClose = props?.onClose ?? vi.fn();
  const onCreated = props?.onCreated ?? vi.fn();
  const utils = render(
    <AddJobModal isOpen onClose={onClose} onCreated={onCreated} {...props} />,
  );
  return { ...utils, onClose, onCreated };
}

async function fillRequiredFields() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/岗位名称/), "后端工程师");
  await user.type(screen.getByLabelText(/公司/), "字节跳动");
  await user.type(screen.getByLabelText(/职位描述/), "负责服务端开发");
  return user;
}

describe("AddJobModal", () => {
  beforeEach(() => {
    mockIngestJob.mockReset();
  });

  it("保存岗位开始准备：提交时调用 ingestJob 并把新岗位交给页面", async () => {
    mockIngestJob.mockResolvedValue({
      created: 1,
      skipped: 0,
      created_job_ids: [456],
      failed: [],
    });
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderModal({ onCreated, onClose });

    const user = await fillRequiredFields();
    await user.click(screen.getByTestId("add-job-submit"));

    await waitFor(() => expect(mockIngestJob).toHaveBeenCalledTimes(1));
    const payload = mockIngestJob.mock.calls[0][0];
    expect(payload).toMatchObject({
      title: "后端工程师",
      company: "字节跳动",
      source: "manual",
      runtime_provider: "replay",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(456));
    expect(onClose).toHaveBeenCalled();
  });

  it("必填字段为空时阻止提交并提示用户", async () => {
    renderModal();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("add-job-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "请填写岗位名称、公司和职位描述",
    );
    expect(mockIngestJob).not.toHaveBeenCalled();
  });

  it("保存失败时展示错误并保留已填写的内容", async () => {
    mockIngestJob.mockRejectedValue(new Error("backend exploded"));
    renderModal();

    const user = await fillRequiredFields();
    await user.click(screen.getByTestId("add-job-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "backend exploded",
    );
    expect(screen.getByLabelText(/岗位名称/)).toHaveValue("后端工程师");
    expect(screen.getByLabelText(/公司/)).toHaveValue("字节跳动");
  });
});
