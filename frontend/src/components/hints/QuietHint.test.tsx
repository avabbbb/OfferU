import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { QuietHint } from "./QuietHint";
import { HINTS_STORAGE_KEY, setHintsEnabled } from "./hintPrefs";

function renderHint() {
  return render(
    <MemoryRouter>
      <p>
        标题 <QuietHint label="这是什么？" action={{ href: "/profile", label: "去档案" }}>一句话说明</QuietHint>
      </p>
      <button type="button">外面的按钮</button>
    </MemoryRouter>,
  );
}

describe("QuietHint — 安静、不强制、需要时可展开", () => {
  afterEach(() => window.localStorage.removeItem(HINTS_STORAGE_KEY));

  it("默认只显示小标记，不自动弹出说明", () => {
    renderHint();
    expect(screen.getByRole("button", { name: "这是什么？" })).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("点击展开说明和指引链接，Esc 关闭", async () => {
    renderHint();
    await userEvent.click(screen.getByRole("button", { name: "这是什么？" }));
    expect(screen.getByRole("note")).toHaveTextContent("一句话说明");
    expect(screen.getByText("去档案").closest("a")).toHaveAttribute("href", "/profile");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("展开时不挡住页面其它操作，点外面即收起", async () => {
    renderHint();
    await userEvent.click(screen.getByRole("button", { name: "这是什么？" }));
    await userEvent.click(screen.getByRole("button", { name: "外面的按钮" }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("设置里关闭提示后整体隐藏，重新打开后恢复", () => {
    renderHint();
    act(() => setHintsEnabled(false));
    expect(screen.queryByTestId("quiet-hint")).not.toBeInTheDocument();
    act(() => setHintsEnabled(true));
    expect(screen.getByTestId("quiet-hint")).toBeInTheDocument();
  });
});
