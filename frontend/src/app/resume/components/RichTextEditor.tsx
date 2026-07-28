// =============================================
// RichTextEditor — TipTap 富文本编辑器封装（增强版）
// =============================================
// 用于简历中 "描述" 类字段（工作描述、项目描述、个人简介等）
// 支持：加粗/斜体/下划线/删除线/列表/对齐/链接/清除格式
// 输出 HTML 字符串，存入后端 content_json 的 description 字段
// =============================================
// 工具栏设计：
//   Figma 风格小型工具栏 — 图标按钮分组排列
//   分组：文字格式 | 列表 | 对齐 | 链接/清除
//   每组用细线隔开，按钮 24px 正方形，hover 高亮
// =============================================

"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  Link as LinkIcon,
  RemoveFormatting,
} from "lucide-react";

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** 最小高度 (px) */
  minHeight?: number;
}

/**
 * TipTap 富文本编辑器（增强版）
 * ─────────────────────────────────────────────
 * 扩展能力：
 * - StarterKit：Bold/Italic/Strike/Code/Heading/BulletList/OrderedList/Blockquote
 * - Underline：下划线
 * - TextAlign：左/中对齐
 * - Link：超链接（rel="noopener noreferrer nofollow"，自动补全 https://）
 * - Placeholder：占位提示文字
 * - Markdown 快捷输入：## 标题、- 列表、> 引用、**加粗** 等自动转换
 * ─────────────────────────────────────────────
 * 工具栏交互：
 * - 链接：选中文字后点击链接图标，弹出 prompt 输入 URL
 *   - 若已有链接则取消链接
 *   - 空 URL 时移除链接
 * - 清除格式：移除所有 mark（保留文字内容），对齐重置为左对齐
 */
export default function RichTextEditor({
  content,
  onChange,
  placeholder = "输入内容...",
  minHeight = 120,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
  });

  if (!editor) return null;

  /**
   * 工具栏按钮样式
   * active：蓝色高亮背景 + 蓝色图标
   * normal：透明背景 + 弱色图标，hover 时微亮
   */
  const btnClass = (active: boolean) =>
    `inline-flex items-center justify-center w-6 h-6 rounded-md transition-all ${
      active
        ? "bg-black text-white"
        : "text-[var(--foreground-muted)] hover:bg-black/10 hover:text-[var(--foreground)]"
    }`;

  /** 插入/编辑链接 — 选中文字后 prompt 输入 URL */
  const handleLink = () => {
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const url = window.prompt("输入链接 URL：");
    if (!url) return;
    const sanitized = url.startsWith("http") ? url : `https://${url}`;
    editor.chain().focus().setLink({ href: sanitized }).run();
  };

  /** 清除所有格式 — 移除 marks + 重置对齐 */
  const handleClearFormat = () => {
    editor.chain().focus().unsetAllMarks().setTextAlign("left").run();
  };

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-strong)]/15 bg-[var(--surface)] shadow-[1px_1px_0_0_rgba(18,18,18,0.08)] transition-colors focus-within:border-[var(--border-strong)]/35">
      {/* 工具栏 — 紧凑分组排列 */}
      <div className="flex items-center gap-0.5 border-b border-[var(--border-strong)]/10 bg-[color:color-mix(in_srgb,var(--surface)_78%,#e8ecef_22%)] px-1.5 py-1">
        {/* 文字格式组 */}
        <button type="button" className={btnClass(editor.isActive("bold"))}
          onClick={() => editor.chain().focus().toggleBold().run()} title="加粗 (Ctrl+B)">
          <Bold size={12} />
        </button>
        <button type="button" className={btnClass(editor.isActive("italic"))}
          onClick={() => editor.chain().focus().toggleItalic().run()} title="斜体 (Ctrl+I)">
          <Italic size={12} />
        </button>
        <button type="button" className={btnClass(editor.isActive("underline"))}
          onClick={() => editor.chain().focus().toggleUnderline().run()} title="下划线 (Ctrl+U)">
          <UnderlineIcon size={12} />
        </button>
        <button type="button" className={btnClass(editor.isActive("strike"))}
          onClick={() => editor.chain().focus().toggleStrike().run()} title="删除线">
          <Strikethrough size={12} />
        </button>

        <div className="mx-0.5 h-3.5 w-px bg-black/12" />

        {/* 列表组 */}
        <button type="button" className={btnClass(editor.isActive("bulletList"))}
          onClick={() => editor.chain().focus().toggleBulletList().run()} title="无序列表">
          <List size={12} />
        </button>
        <button type="button" className={btnClass(editor.isActive("orderedList"))}
          onClick={() => editor.chain().focus().toggleOrderedList().run()} title="有序列表">
          <ListOrdered size={12} />
        </button>

        <div className="mx-0.5 h-3.5 w-px bg-black/12" />

        {/* 对齐组 */}
        <button type="button" className={btnClass(editor.isActive({ textAlign: "left" }))}
          onClick={() => editor.chain().focus().setTextAlign("left").run()} title="左对齐">
          <AlignLeft size={12} />
        </button>
        <button type="button" className={btnClass(editor.isActive({ textAlign: "center" }))}
          onClick={() => editor.chain().focus().setTextAlign("center").run()} title="居中">
          <AlignCenter size={12} />
        </button>

        <div className="mx-0.5 h-3.5 w-px bg-black/12" />

        {/* 链接 + 清除格式 */}
        <button type="button" className={btnClass(editor.isActive("link"))}
          onClick={handleLink} title={editor.isActive("link") ? "取消链接" : "插入链接"}>
          <LinkIcon size={12} />
        </button>
        <button type="button" className={btnClass(false)}
          onClick={handleClearFormat} title="清除格式">
          <RemoveFormatting size={12} />
        </button>
      </div>
      {/* 编辑区 */}
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none px-3 py-2 text-[var(--foreground)]"
        style={{ minHeight }}
      />
    </div>
  );
}
