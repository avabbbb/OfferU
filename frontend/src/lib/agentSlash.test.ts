import { describe, expect, it } from "vitest";
import { filterSlashCommands, removeSlashToken, slashTrigger, type SlashCommand } from "./agentSlash";
import { moveListboxIndex } from "./useListboxKeyboard";

const COMMANDS: SlashCommand[] = [
  { id: "new", label: "新对话", group: "对话", hint: "/new" },
  { id: "history", label: "历史对话", group: "对话", hint: "/history", keywords: ["切换"] },
  { id: "model", label: "切换模型", group: "输入", hint: "/model", description: "服务 › 模型 › 思考强度" },
];

describe("slashTrigger", () => {
  it("fires only for a / at line start or after whitespace, before the caret", () => {
    expect(slashTrigger("/")).toEqual({ start: 0, query: "" });
    expect(slashTrigger("帮我 /mo")).toEqual({ start: 3, query: "mo" });
    expect(slashTrigger("a/b")).toBeNull();
    expect(slashTrigger("https://x.com")).toBeNull();
    expect(slashTrigger("/new 之后", 4)).toEqual({ start: 0, query: "new" });
    expect(slashTrigger("/new 之后")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  it("ranks hint / id prefixes first and keeps group order on ties", () => {
    expect(filterSlashCommands(COMMANDS, "").map((item) => item.id)).toEqual(["new", "history", "model"]);
    expect(filterSlashCommands(COMMANDS, "h").map((item) => item.id)).toEqual(["history"]);
    expect(filterSlashCommands(COMMANDS, "切换").map((item) => item.id)).toEqual(["model", "history"]);
    expect(filterSlashCommands(COMMANDS, "思考").map((item) => item.id)).toEqual(["model"]);
    expect(filterSlashCommands(COMMANDS, "zzz")).toEqual([]);
  });
});

describe("removeSlashToken", () => {
  it("drops the /query and one following space", () => {
    expect(removeSlashToken("帮我 /mo 看看", { start: 3, query: "mo" }, 6)).toEqual({ text: "帮我 看看", caret: 3 });
    expect(removeSlashToken("/new", { start: 0, query: "new" })).toEqual({ text: "", caret: 0 });
  });
});

describe("moveListboxIndex", () => {
  it("wraps and skips non-navigable rows", () => {
    expect(moveListboxIndex(-1, 3, 1, { wrap: true })).toBe(0);
    expect(moveListboxIndex(2, 3, 1, { wrap: true })).toBe(0);
    expect(moveListboxIndex(0, 3, -1, { wrap: true })).toBe(2);
    expect(moveListboxIndex(0, 3, 1, { wrap: true, isNavigable: (index) => index !== 1 })).toBe(2);
  });
});
