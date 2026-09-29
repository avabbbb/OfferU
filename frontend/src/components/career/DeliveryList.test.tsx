import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

import { DeliveryList } from "./DeliveryList";
import type { CareerDelivery } from "@/lib/api";

describe("DeliveryList", () => {
  it("shows real delivery state and links to the canonical workspace without guessing an artifact API", () => {
    const deliveries: CareerDelivery[] = [
      {
        state: "ready",
        artifact_id: "artifact-11",
        artifact_type: "interview_prep",
        job_id: 73,
        title: "面试准备提纲",
        href: "/jobs/73?artifact=artifact-11",
        practice: { answered: 1, total: 4, completed: false },
      },
      {
        state: "blocked",
        artifact_type: "follow_up_draft",
        title: "招聘方跟进草稿",
        reason: "缺少经过确认的下一步信息",
      },
    ];

    render(<DeliveryList deliveries={deliveries} heading="OfferU 已准备的内容" />);

    expect(screen.getByText("面试准备提纲")).toBeInTheDocument();
    expect(screen.getByText("已保存，详情暂不可打开")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开岗位工作区" })).toHaveAttribute("href", "/jobs/73");
    expect(screen.queryByRole("link", { name: "打开练习" })).not.toBeInTheDocument();
    expect(screen.getByText("缺少经过确认的下一步信息")).toBeInTheDocument();
    expect(screen.queryByText(/草稿已保存/)).not.toBeInTheDocument();
  });

  it("does not offer opening controls for suggested or preparing work", () => {
    render(
      <DeliveryList
        deliveries={[
          { state: "suggested", artifact_type: "interview_prep", title: "面试准备", job_id: 18 },
          { state: "preparing", artifact_type: "tailored_resume_proposal", title: "简历提案", job_id: 19 },
        ]}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId("career-delivery")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /打开|查看/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
