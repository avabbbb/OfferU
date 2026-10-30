"use client";

// 左侧拖动手柄：悬停块时在纸的左外侧显示，拖动改顺序。拖分节标题（##）时连同整节（到下一个分节为止）一起走。
// 不用 ProseMirror 自带的拖放：多块整节没法表示成一个选区，这里自己算范围、自己 dispatch，一次拖动 = 一步撤销。
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEffect, useRef, useState, type RefObject } from "react";

/** 第 index 个顶层块要拖动的范围 [from, to)；分节标题带上整节。 */
export function blockRange(doc: PMNode, index: number) {
  let from = 0;
  for (let i = 0; i < index; i += 1) from += doc.child(i).nodeSize;
  const head = doc.child(index);
  let to = from + head.nodeSize;
  if (head.type.name === "heading" && head.attrs.level === 2) {
    for (let i = index + 1; i < doc.childCount; i += 1) {
      const node = doc.child(i);
      if (node.type.name === "heading" && node.attrs.level <= 2) break;
      to += node.nodeSize;
    }
  }
  return { from, to };
}

/** 把 [from, to) 移到 target（顶层块边界）。target 落在自身范围内时不动，返回 null。 */
export function moveRange(doc: PMNode, from: number, to: number, target: number) {
  if (target >= from && target <= to) return null;
  const content = doc.slice(from, to).content;
  return { content, insertAt: target > to ? target - (to - from) : target };
}

type Block = { index: number; pos: number; end: number; rect: DOMRect };

export function BlockHandle({ editor, paper, zoom }: { editor: Editor; paper: RefObject<HTMLDivElement | null>; zoom: number }) {
  const [hover, setHover] = useState<{ index: number; top: number } | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const drag = useRef<{ from: number; to: number } | null>(null);

  useEffect(() => {
    const host = paper.current;
    if (!host) return;
    const view = editor.view;
    const blocks = () => {
      const out: Block[] = [];
      view.state.doc.forEach((node, offset, index) => {
        const el = view.nodeDOM(offset);
        if (el instanceof HTMLElement) out.push({ index, pos: offset, end: offset + node.nodeSize, rect: el.getBoundingClientRect() });
      });
      return out;
    };
    const blockAt = (y: number) => {
      const list = blocks();
      return list.find((b) => y < b.rect.bottom) ?? list[list.length - 1];
    };
    const local = (y: number) => (y - host.getBoundingClientRect().top) / zoom;
    const dropTarget = (y: number) => {
      const b = blockAt(y);
      if (!b) return null;
      const after = y > (b.rect.top + b.rect.bottom) / 2;
      return { pos: after ? b.end : b.pos, top: local(after ? b.rect.bottom : b.rect.top) };
    };

    const onMove = (e: MouseEvent) => {
      if (drag.current) return;
      const b = blockAt(e.clientY);
      setHover(b ? { index: b.index, top: local(b.rect.top) } : null);
    };
    const onLeave = (e: MouseEvent) => {
      if (!host.contains(e.relatedTarget as globalThis.Node | null)) setHover(null);
    };
    // 捕获阶段拦下，只处理手柄发起的拖动；选中文字的普通拖放仍交给编辑器。
    const onOver = (e: DragEvent) => {
      if (!drag.current) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      setLine(dropTarget(e.clientY)?.top ?? null);
    };
    const onDrop = (e: DragEvent) => {
      const src = drag.current;
      if (!src) return;
      e.preventDefault();
      e.stopPropagation();
      drag.current = null;
      setLine(null);
      const t = dropTarget(e.clientY);
      const move = t && moveRange(view.state.doc, src.from, src.to, t.pos);
      if (!move) return;
      view.dispatch(view.state.tr.delete(src.from, src.to).insert(move.insertAt, move.content).scrollIntoView());
      view.focus();
    };

    host.addEventListener("mousemove", onMove);
    host.addEventListener("mouseleave", onLeave);
    host.addEventListener("dragover", onOver, true);
    host.addEventListener("drop", onDrop, true);
    return () => {
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("mouseleave", onLeave);
      host.removeEventListener("dragover", onOver, true);
      host.removeEventListener("drop", onDrop, true);
    };
  }, [editor, paper, zoom]);

  return (
    <>
      {hover && editor.isEditable && (
        <button type="button" draggable aria-label="拖动排序" title="拖动排序（拖分节标题会带上整节）"
          onDragStart={(e) => {
            const range = blockRange(editor.state.doc, hover.index);
            drag.current = range;
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", "");
            const el = editor.view.nodeDOM(range.from);
            if (el instanceof HTMLElement) e.dataTransfer.setDragImage(el, 0, 0);
          }}
          onDragEnd={() => { drag.current = null; setLine(null); }}
          style={{ top: hover.top }}
          className="absolute -left-6 flex h-6 w-5 cursor-grab select-none items-center justify-center rounded text-[13px] leading-none text-[#aeaeb2] hover:bg-black/5 hover:text-[#6e6e73]">
          ⠿
        </button>
      )}
      {line !== null && <div style={{ top: line }} className="pointer-events-none absolute left-0 right-0 h-0.5 bg-[#2f6feb]" />}
    </>
  );
}
