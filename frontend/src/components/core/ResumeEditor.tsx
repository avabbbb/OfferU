"use client";

// Typora 式编辑：直接在 A4 纸上写，存的是 Markdown。纸面样式和导出 PDF 是同一份 CSS（backend/app/core/templates）。
import { Extension } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";

import { apiUrl } from "@/lib/core";
import { SlashMenu } from "@/components/resume/SlashMenu";
import { FormatBubble } from "@/components/resume/FormatBubble";
import { BlockHandle } from "@/components/resume/BlockHandle";

/** 回车多按出来的空段落会被序列化成 &nbsp;，存之前去掉。 */
export const tidy = (md: string) => md.split("\n").filter((l) => l.trim() !== "&nbsp;").join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";

const A4_W = 794;
const A4_H = 1123;

/** ### 公司 | 职位 | 时间：光标不在这一行时，像 PDF 一样排成「公司 · 职位 …… 时间」；光标进来就显示原文。 */
const ResumeRow = Extension.create({
  name: "resumeRow",
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("resumeRow"),
      props: {
        decorations(state) {
          const decos: Decoration[] = [];
          const { from, to } = state.selection;
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "heading" || node.attrs.level !== 3) return true;
            const start = pos + 1;
            const end = pos + node.nodeSize - 1;
            const text = node.textContent;
            const bars = [...text].flatMap((c, i) => (c === "|" ? [i] : []));
            if (!bars.length || (from <= end && to >= start)) return false;
            bars.forEach((bar, k) => {
              let a = bar;
              let b = bar + 1;
              while (a > 0 && text[a - 1] === " ") a -= 1;
              while (b < text.length && text[b] === " ") b += 1;
              decos.push(Decoration.inline(start + a, start + b, { class: k === bars.length - 1 ? "sep-r" : "sep" }));
              const next = k + 1 < bars.length ? bars[k + 1] : text.length;
              let segEnd = next;
              while (segEnd > b && text[segEnd - 1] === " ") segEnd -= 1;
              if (segEnd > b) decos.push(Decoration.inline(start + b, start + segEnd, { class: k === bars.length - 1 ? "r" : "seg" }));
            });
            return false;
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })];
  },
});

export function ResumeEditor({ body, template, photo, source, onChange }: {
  body: string; template: string; photo?: string; source: boolean; onChange: (markdown: string) => void;
}) {
  const [css, setCss] = useState("");
  const [zoom, setZoom] = useState(1);
  const [overflow, setOverflow] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const emitted = useRef(body);

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false, codeBlock: false, code: false, blockquote: false, horizontalRule: false }), Markdown, ResumeRow, SlashMenu],
    content: body,
    contentType: "markdown",
    immediatelyRender: true,
    editorProps: { attributes: { "aria-label": "简历内容", spellcheck: "false" } },
    onUpdate: ({ editor: e }) => { emitted.current = tidy(e.getMarkdown()); onChange(emitted.current); },
    // 离开编辑器时把空段落也从纸上去掉，保证纸面和 PDF 一致。
    onBlur: ({ editor: e }) => { if (e.getMarkdown() !== emitted.current) e.commands.setContent(emitted.current, { contentType: "markdown", emitUpdate: false }); },
  });

  // Agent 改了、或者撤销了：外面的内容和我们最后写出去的不一样，就换成外面的。
  useEffect(() => {
    if (editor && body !== emitted.current && !editor.isFocused) {
      emitted.current = body;
      editor.commands.setContent(body, { contentType: "markdown", emitUpdate: false });
    }
  }, [body, editor]);

  useEffect(() => {
    void fetch(apiUrl(`/api/resume/templates/${template}.css`)).then((r) => r.text()).then(setCss).catch(() => {});
  }, [template]);

  useEffect(() => {
    const el = box.current;
    const page = paper.current;
    if (!el || !page) return;
    const ro = new ResizeObserver(() => {
      setZoom(Math.min(1, (el.clientWidth - 48) / A4_W));
      setOverflow(page.scrollHeight > A4_H + 2);
    });
    ro.observe(el);
    ro.observe(page);
    return () => ro.disconnect();
  }, [source]);

  const showPhoto = photo;
  return (
    <div ref={box} className="min-w-0 flex-1 overflow-auto px-6 py-6">
      <style>{`${css}
        .resume .ProseMirror { outline: none; white-space: pre-wrap; min-height: calc(${A4_H}px - 2 * var(--pad-y)); }
        .resume .ProseMirror > *:first-child { margin-top: 0; }
        .resume .page-end { position: absolute; left: 0; right: 0; top: ${A4_H}px; border-top: 1px dashed #c7c7cc; pointer-events: none; }
        .resume .page-end span { position: absolute; right: -76px; top: -9px; font-size: 11px; color: #8e8e93; }`}</style>
      {source ? (
        <textarea value={body} onChange={(e) => onChange(e.target.value)} aria-label="简历源码（Markdown）" spellCheck={false}
          style={{ fontSize: 13 }} className="mx-auto block min-h-[80vh] w-full max-w-[794px] resize-none rounded-md bg-[var(--surface)] p-6 font-mono text-[13px] leading-6 text-[var(--foreground)] outline-none" />
      ) : (
        <div style={{ zoom }} className="mx-auto w-[794px]">
          <div ref={paper} className={`resume${showPhoto ? " photo-on" : ""} shadow-[0_0_0_1px_var(--border),0_10px_30px_rgba(0,0,0,0.06)]`}>
            {showPhoto && <img className="photo" src={apiUrl(`/api/files/${photo}`)} alt="" />}
            <EditorContent editor={editor} />
            {editor && <FormatBubble editor={editor} />}
            {editor && <BlockHandle editor={editor} paper={paper} zoom={zoom} />}
            {overflow && <div className="page-end"><span>第一页到这</span></div>}
          </div>
        </div>
      )}
    </div>
  );
}
