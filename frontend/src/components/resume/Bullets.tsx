"use client";

// 条目里的要点列表（从原 ResumeForm 拆出来，右栏条目编辑复用）。
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

import { Menu } from "@/components/ui";
import { move } from "@/lib/resumeModel";

import { RichText } from "./RichText";

// 操作按钮的线性小图标（同一套 24 视框、currentColor）。
const GLYPH = {
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  eye: "M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff: "M3 3l18 18M10.6 6.1Q11.3 6 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3 3.6M6.5 6.6C3.8 8.3 2 12 2 12s3.6 6 10 6c1.5 0 2.9-.3 4.1-.9M9.9 9.9a3 3 0 0 0 4.2 4.2",
  pencil: "M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4",
  chevron: "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  grip: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01",
} as const;

export function Glyph({ name }: { name: keyof typeof GLYPH }) {
  return (
    <svg className="rf-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d={GLYPH[name]} />
    </svg>
  );
}

// 要点 = 一行一块（文档式，参照 Notion / Bleep）：回车在下面新建、空块退格删掉并回到上一块、↑↓ 在块之间走。
// 悬停时左侧留白里浮出「+」（下面加一条）和「⋮⋮」把手：拖动把手排序，单击把手开菜单（上移 / 下移 / 删除）。
// 把手和按钮都绝对定位在左边留白里，藏起来时不占正文宽度。
export function Bullets({ bullets, onChange }: { bullets: string[]; onChange: (next: string[]) => void }) {
  const [focus, setFocus] = useState<{ i: number; n: number }>({ i: -1, n: 0 });
  const [menuFor, setMenuFor] = useState(-1);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const keepFocus = useRef(false); // 菜单里选了「在下面加一条」：关菜单时别把焦点抢回把手
  const go = (i: number) => setFocus((f) => ({ i, n: f.n + 1 }));
  const set = (i: number, value: string) => onChange(bullets.map((b, k) => (k === i ? value : b)));
  const insert = (i: number) => { onChange([...bullets.slice(0, i), "", ...bullets.slice(i)]); go(i); };
  const remove = (i: number) => onChange(bullets.filter((_, k) => k !== i));

  // 按下把手：移动超过 4px 就是拖动排序（落点 = 指针在哪一行的上半 / 下半），否则松手时当单击，打开菜单。
  const grab = (i: number, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 不让 Radix 在按下时就开菜单
    const x0 = e.clientX, y0 = e.clientY;
    let to = -1;
    const onMove = (ev: PointerEvent) => {
      if (to < 0 && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      const rows = Array.from(list.current?.querySelectorAll<HTMLElement>(":scope > .rf-bullet") ?? []);
      const at = rows.findIndex((row) => { const r = row.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      to = at < 0 ? rows.length : at;
      setDrag({ from: i, to });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (to < 0) { setMenuFor(i); return; }
      const dest = to > i ? to - 1 : to;
      if (dest !== i) onChange(move(bullets, i, dest));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div ref={list} className="rf-blocks" data-dragging={drag ? "" : undefined}>
      {bullets.map((b, i) => (
        <div key={i} className="rf-bullet" data-dragged={drag?.from === i || undefined}
          data-drop={drag && drag.to !== drag.from && drag.to !== drag.from + 1 ? (drag.to === i ? "before" : drag.to === i + 1 && i === bullets.length - 1 ? "after" : undefined) : undefined}>
          <div className="rf-gutter" data-open={menuFor === i || undefined}>
            <button type="button" className="rf-gutter-btn" aria-label={"在要点 " + (i + 1) + " 下面加一条"} title="在下面加一条"
              onClick={() => insert(i + 1)}>
              <Glyph name="plus" />
            </button>
            <Menu align="start" side="bottom" open={menuFor === i} onOpenChange={(open) => setMenuFor(open ? i : -1)}
              onCloseAutoFocus={(e) => { if (keepFocus.current) { e.preventDefault(); keepFocus.current = false; } }}
              trigger={
                <button type="button" className="rf-gutter-btn rf-grip" aria-label={"要点 " + (i + 1) + "：拖动排序，单击更多操作"}
                  title="拖动排序 · 单击更多" onPointerDown={(e) => grab(i, e)}>
                  <Glyph name="grip" />
                </button>
              }
              items={[
                { label: "上移", icon: <Glyph name="up" />, disabled: i === 0, onSelect: () => onChange(move(bullets, i, i - 1)) },
                { label: "下移", icon: <Glyph name="down" />, disabled: i === bullets.length - 1, onSelect: () => onChange(move(bullets, i, i + 1)) },
                { label: "在下面加一条", icon: <Glyph name="plus" />, onSelect: () => { keepFocus.current = true; insert(i + 1); } },
                "separator",
                { label: "删除要点", icon: <Glyph name="trash" />, danger: true, onSelect: () => remove(i) },
              ]} />
          </div>
          <span className="rf-dot" aria-hidden />
          <RichText value={b} rows={1} compact label={"要点 " + (i + 1)} onChange={(v) => set(i, v)}
            focusSignal={focus.i === i ? focus.n : 0}
            keys={{
              onEnter: () => insert(i + 1),
              onRemove: () => { remove(i); if (i > 0) go(i - 1); },
              onPrev: i > 0 ? () => go(i - 1) : undefined,
              onNext: i < bullets.length - 1 ? () => go(i + 1) : undefined,
            }} />
        </div>
      ))}
      <button type="button" className="rf-link rf-add-line" onClick={() => insert(bullets.length)}><Glyph name="plus" />添加要点</button>
    </div>
  );
}
