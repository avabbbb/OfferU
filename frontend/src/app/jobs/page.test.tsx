import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUseJobs, mockUseScraperTasks, mockUsePools, mockRouterPush, mockUseSearchParams } =
  vi.hoisted(() => ({
    mockUseJobs: vi.fn(),
    mockUseScraperTasks: vi.fn(),
    mockUsePools: vi.fn(),
    mockRouterPush: vi.fn(),
    mockUseSearchParams: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  useSearchParams: mockUseSearchParams,
  usePathname: () => "/jobs",
}));

vi.mock("../../lib/hooks", () => ({
  useJobs: mockUseJobs,
  useScraperTasks: mockUseScraperTasks,
  usePools: mockUsePools,
  patchJobsBatch: vi.fn(),
  deleteJobsBatch: vi.fn(),
  createPool: vi.fn(),
  updatePoolName: vi.fn(),
  deletePoolById: vi.fn(),
}));

vi.mock("../../lib/api", () => ({
  jobsApi: { list: vi.fn() },
}));

vi.mock("../../lib/showcase/router", () => ({ SHOWCASE: false }));

vi.mock("../../components/jobs/AddJobModal", () => ({
  AddJobModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="add-job-modal-open" /> : null,
}));

vi.mock("../../components/jobs/JobCard", () => ({
  JobCard: ({ job }: { job: { id: number; title: string } }) => (
    <div data-testid={`job-card-${job.id}`}>{job.title}</div>
  ),
}));

import JobsPage from "./page";

const baseJobsResult = {
  data: { items: [], total: 0, page: 1, page_size: 21 },
  isLoading: false,
  isValidating: false,
  mutate: vi.fn(),
};

describe("JobsPage", () => {
  beforeEach(() => {
    mockUseJobs.mockReset().mockReturnValue({ ...baseJobsResult });
    mockUseScraperTasks.mockReset().mockReturnValue({ data: [] });
    mockUsePools.mockReset().mockReturnValue({ data: [], mutate: vi.fn() });
    mockUseSearchParams.mockReset().mockReturnValue(new URLSearchParams(""));
    mockRouterPush.mockReset();
  });

  it("首屏加载时展示加载提示而不是空白", () => {
    mockUseJobs.mockReturnValue({
      data: undefined,
      isLoading: true,
      isValidating: true,
      mutate: vi.fn(),
    });
    render(<JobsPage />);
    expect(screen.getByText("岗位数据加载中...")).toBeInTheDocument();
  });

  it("空结果时给出下一步动作入口", async () => {
    render(<JobsPage />);
    expect(await screen.findByText("暂无岗位结果")).toBeInTheDocument();
    const cta = screen.getByTestId("empty-add-job");
    expect(cta).toHaveTextContent("保存第一个岗位");

    cta.click();
    expect(await screen.findByTestId("add-job-modal-open")).toBeInTheDocument();
  });
});
