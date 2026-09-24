import { act, render, screen, waitFor } from "@testing-library/react";
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
      resolved_job_ids: [456],
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
    expect(onClose).toHaveBeenCalledWith("created");
  });

  it("提交进行中禁用按钮并阻止重复点击", async () => {
    let finishIngest!: (value: {
      created: number;
      skipped: number;
      created_job_ids: number[];
      resolved_job_ids: number[];
      failed: never[];
    }) => void;
    mockIngestJob.mockReturnValue(
      new Promise((resolve) => {
        finishIngest = resolve;
      }),
    );
    const onCreated = vi.fn();
    renderModal({ onCreated });

    const user = await fillRequiredFields();
    const submit = screen.getByTestId("add-job-submit");
    await user.click(submit);

    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(mockIngestJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishIngest({
        created: 1,
        skipped: 0,
        created_job_ids: [456],
        resolved_job_ids: [456],
        failed: [],
      });
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(456));
  });

  it("幂等重试返回已存在的岗位时仍把 canonical Job 交给页面", async () => {
    mockIngestJob.mockResolvedValue({
      created: 0,
      skipped: 1,
      created_job_ids: [],
      resolved_job_ids: [789],
      failed: [],
    });
    const onCreated = vi.fn();
    renderModal({ onCreated });

    const user = await fillRequiredFields();
    await user.click(screen.getByTestId("add-job-submit"));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(789));
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
