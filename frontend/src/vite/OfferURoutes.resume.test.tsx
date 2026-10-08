import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/resume/page", () => ({ default: () => <p>简历列表</p> }));
vi.mock("@/app/optimize/page", () => ({ default: () => <p>岗位定制内容</p> }));
vi.mock("@/app/studio/page", () => ({ default: () => <p>版式内容</p> }));

import ResumeHub from "@/app/resume/ResumeHub";
import { OfferURoutes } from "./OfferURoutes";

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OfferURoutes />
      <Routes><Route path="*" element={<Where />} /></Routes>
    </MemoryRouter>,
  );
}

describe("简历三入口合一", () => {
  it("旧 /optimize 链接带着岗位参数进入「岗位定制」", async () => {
    renderAt("/optimize?job_ids=9");
    expect(await screen.findByText("岗位定制内容")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/resume?job_ids=9&mode=tailor");
  });

  it("旧 /studio 链接进入「版式」", async () => {
    renderAt("/studio");
    expect(await screen.findByText("版式内容")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/resume?mode=layout");
  });

  it("三个模式都在同一排标签里，当前模式高亮", async () => {
    render(<MemoryRouter initialEntries={["/resume?mode=tailor"]}><ResumeHub /></MemoryRouter>);
    expect(await screen.findByText("岗位定制内容")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "岗位定制" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "我的简历" })).toHaveAttribute("href", "/resume");
    expect(screen.getByRole("link", { name: "版式" })).toHaveAttribute("href", "/resume?mode=layout");
  });
});
