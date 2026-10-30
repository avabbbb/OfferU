"use client";

// 选中文字浮出的格式栏：加粗、斜体，以及把当前块转成要点 / 经历 / 段落。颜色只有全局主题色（Markdown 存不下单段颜色）。
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";

type Item = { label: string; title: string; active: boolean; run: () => void };

export function FormatBubble({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      bullet: e.isActive("bulletList"),
      row: e.isActive("heading", { level: 3 }),
      paragraph: e.isActive("paragraph") && !e.isActive("bulletList"),
    }),
  });
  const c = () => editor.chain().focus();
  const marks: Item[] = [
    { label: "B", title: "加粗（Ctrl+B）", active: s.bold, run: () => c().toggleBold().run() },
    { label: "I", title: "斜体（Ctrl+I）", active: s.italic, run: () => c().toggleItalic().run() },
  ];
  const blocks: Item[] = [
    { label: "要点", title: "转成要点", active: s.bullet, run: () => c().toggleBulletList().run() },
    { label: "经历", title: "转成经历标题（公司 | 职位 | 时间）", active: s.row, run: () => c().toggleHeading({ level: 3 }).run() },
    { label: "段落", title: "转成段落", active: s.paragraph, run: () => c().liftListItem("listItem").setParagraph().run() },
  ];
  const btn = (it: Item) => (
    <button key={it.label} type="button" title={it.title} aria-pressed={it.active}
      onMouseDown={(e) => { e.preventDefault(); it.run(); }}
      className={"rounded px-2 py-1 text-[12px] leading-none " + (it.active ? "bg-[var(--surface)] text-[var(--foreground)]" : "text-[var(--muted-foreground,#6e6e73)] hover:bg-[var(--surface)]")}
      style={it.label === "B" ? { fontWeight: 700 } : it.label === "I" ? { fontStyle: "italic" } : undefined}>
      {it.label}
    </button>
  );
  return (
    <BubbleMenu editor={editor} shouldShow={({ editor: e, state }) => e.isEditable && !state.selection.empty}
      className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--background)] p-1 shadow-lg">
      {marks.map(btn)}
      <span className="mx-1 h-4 w-px bg-[var(--border)]" />
      {blocks.map(btn)}
    </BubbleMenu>
  );
}
