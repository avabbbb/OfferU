import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import ResumeDesignPanel from "./ResumeDesignPanel";

it("allows typing fractional sizes without clamping an unfinished number", async () => {
  function Editor() {
    const [config, setConfig] = useState<Record<string, string>>({ template: "reference" });
    return <ResumeDesignPanel config={config} onChange={(key, value) => setConfig((current) => ({ ...current, [key]: value }))} onUpload={async () => {}} uploading={false} />;
  }
  const user = userEvent.setup();
  render(<Editor />);
  const size = screen.getByLabelText("正文字号 (pt)");
  await user.clear(size);
  await user.type(size, "10.75");
  await user.tab();
  expect(size).toHaveValue(10.75);
  await user.clear(size);
  await user.type(size, "99");
  await user.tab();
  expect(size).toHaveValue(20);
});
