"use client";

// / 块菜单：输入 / 弹出可插入的块。块就是 Markdown 结构（分节 H2、经历 H3、要点列表、段落），存盘仍是 Markdown。
import { Extension, type Editor, type Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";

export type Block = { title: string; hint: string; keys: string; run: (editor: Editor, range: Range) => void };

const text = (t: string) => [{ type: "text", text: t }];
const h = (level: number, t: string) => ({ type: "heading", attrs: { level }, content: text(t) });
const bullet = (t: string) => ({ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: text(t) }] }] });
const section = (name: string, row: string, point: string) => (e: Editor, r: Range) => {
  e.chain().focus().deleteRange(r).insertContent([h(2, name), h(3, row), bullet(point)]).run();
};

export const BLOCKS: Block[] = [
  { title: "分节", hint: "## 标题", keys: "section fenjie h2", run: (e, r) => { e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run(); } },
  { title: "经历", hint: "公司 | 职位 | 时间", keys: "row jingli h3", run: (e, r) => { e.chain().focus().deleteRange(r).insertContent(h(3, "公司 | 职位 | 2024.06 – 2024.09")).run(); } },
  { title: "要点", hint: "- 做了什么，结果如何", keys: "bullet yaodian list", run: (e, r) => { e.chain().focus().deleteRange(r).toggleBulletList().run(); } },
  { title: "段落", hint: "普通文字", keys: "paragraph duanluo text", run: (e, r) => { e.chain().focus().deleteRange(r).setParagraph().run(); } },
  { title: "教育经历", hint: "学校 | 专业 | 时间", keys: "education jiaoyu", run: section("教育经历", "学校 | 专业 · 本科 | 2021.09 – 2025.06", "GPA / 排名 / 主修课程") },
  { title: "实习经历", hint: "公司 | 职位 | 时间", keys: "experience shixi intern", run: section("实习经历", "公司 | 职位 | 2024.06 – 2024.09", "负责什么，用了什么方法，带来什么结果（尽量量化）") },
  { title: "项目经历", hint: "项目 | 角色 | 时间", keys: "project xiangmu", run: section("项目经历", "项目名 | 角色 | 2023.03 – 2023.06", "项目目标、你的贡献和结果") },
  { title: "技能", hint: "语言 / 工具 / 证书", keys: "skill jineng", run: (e, r) => { e.chain().focus().deleteRange(r).insertContent([h(2, "技能"), bullet("编程：Python、SQL"), bullet("语言：CET-6")]).run(); } },
  { title: "获奖", hint: "奖项 | 级别 | 时间", keys: "award huojiang", run: section("获奖", "奖项名称 | 级别 | 2024.05", "一句话说明含金量") },
];

export const filterBlocks = (query: string) => {
  const q = query.trim().toLowerCase();
  return q ? BLOCKS.filter((b) => b.title.includes(q) || b.keys.includes(q)) : BLOCKS;
};

type ListHandle = { onKeyDown: (p: SuggestionKeyDownProps) => boolean };
type ListProps = SuggestionProps<Block, Block>;

const SlashList = forwardRef<ListHandle, ListProps>(({ items, command }, ref) => {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") { setActive((a) => (a + 1) % items.length); return true; }
      if (event.key === "ArrowUp") { setActive((a) => (a + items.length - 1) % items.length); return true; }
      if (event.key === "Enter") { command(items[active]); return true; }
      return false;
    },
  }), [items, active, command]);
  if (!items.length) return null;
  return (
    <div role="listbox" aria-label="插入块" className="w-60 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] py-1 text-[13px] shadow-lg">
      {items.map((item, i) => (
        <button key={item.title} type="button" role="option" aria-selected={i === active}
          onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); command(item); }}
          className={"flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left" + (i === active ? " bg-[var(--surface)]" : "")}>
          <span className="text-[var(--foreground)]">{item.title}</span>
          <span className="truncate text-[11px] text-[var(--muted-foreground,#8e8e93)]">{item.hint}</span>
        </button>
      ))}
    </div>
  );
});
SlashList.displayName = "SlashList";

export const SlashMenu = Extension.create({
  name: "slashMenu",
  addProseMirrorPlugins() {
    return [Suggestion<Block, Block>({
      editor: this.editor,
      char: "/",
      items: ({ query }) => filterBlocks(query),
      command: ({ editor, range, props }) => props.run(editor, range),
      render: () => {
        let view: ReactRenderer<ListHandle, ListProps> | null = null;
        const place = (p: ListProps) => {
          const rect = p.clientRect?.();
          const el = view?.element as HTMLElement | undefined;
          if (!rect || !el) return;
          el.style.left = rect.left + "px";
          el.style.top = rect.bottom + 6 + "px";
        };
        const close = () => { view?.element.remove(); view?.destroy(); view = null; };
        return {
          onStart: (p) => {
            view = new ReactRenderer(SlashList, { props: p, editor: p.editor });
            const el = view.element as HTMLElement;
            el.style.position = "fixed";
            el.style.zIndex = "50";
            document.body.appendChild(el);
            place(p);
          },
          onUpdate: (p) => { view?.updateProps(p); place(p); },
          onKeyDown: (p) => {
            if (p.event.key === "Escape") { close(); return true; }
            return view?.ref?.onKeyDown(p) ?? false;
          },
          onExit: close,
        };
      },
    })];
  },
});
