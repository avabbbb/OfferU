"use client";

/**
 * 「纸」模板：成品即编辑器。
 *
 * 同一个组件既是导出 PDF 用的成品，也是工作区里可以直接点字修改的画布
 * （editable=true）。所以画布上看到的就是导出的样子，没有表单与预览两套东西。
 *
 * 排版约束参考 tw93/Kami（MIT）的 design.md：单一强调色、暖灰、单衬线两字重、
 * 字号阶梯、减法装饰、4pt 间距网格。中文字体只用 OFL 许可的思源宋体 / Noto Serif SC，
 * 不使用仅限个人免费的仓耳今楷。
 */

import { Fragment, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BOLD_CLOSE, BOLD_OPEN, normalizeBold, plainBullet, richBulletToHtml, splitRichBullets } from "@/lib/resumeText";

export interface PaperSection {
  id: number;
  section_type: string;
  title: string;
  visible: boolean;
  content_json: any[];
  sort_order: number;
}

export interface ResumePaperProps {
  userName: string;
  title?: string;
  summary: string;
  contactJson: Record<string, string>;
  sections: PaperSection[];
  styleConfig: Record<string, string>;
  editable?: boolean;
  onProfileChange?: (patch: { user_name?: string; title?: string; summary?: string; contact_json?: Record<string, string> }) => void;
  onSectionChange?: (section: PaperSection) => void;
  /** 已解析为可加载地址的证件照 / 校徽；为空时成品上不占位。 */
  photoUrl?: string;
  logoUrl?: string;
  /** 仅画布：在页面上直接添加、更换或移除照片和校徽（file 为 null 表示移除）。 */
  onUploadAsset?: (kind: "photo" | "logo", file: File | null) => void | Promise<void>;
}

const ASSET_ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * 照片与校徽：成品里只有图片本身（无边框、无阴影，圆角 2pt）；
 * 画布上空位显示为虚线占位，悬停出现「更换 / 移除」，这些控件不进入导出。
 */
function PaperAsset({ kind, url, editable, onUpload }: {
  kind: "photo" | "logo";
  url?: string;
  editable: boolean;
  onUpload?: ResumePaperProps["onUploadAsset"];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const label = kind === "photo" ? "照片" : "校徽";
  if (!url && !(editable && onUpload)) return null;
  const pick = () => inputRef.current?.click();
  return (
    <div className={`paper-asset paper-asset-${kind}${url ? "" : " paper-asset-empty"}`} data-testid={`paper-asset-${kind}`}>
      {url ? (
        <img className={`paper-${kind}`} src={url} alt={label} />
      ) : (
        <button type="button" className="paper-asset-add" data-paper-chrome="" onClick={pick} aria-label={`添加${label}`}>
          ＋ {label}
        </button>
      )}
      {editable && onUpload && (
        <>
          {url && (
            <span className="paper-asset-actions" data-paper-chrome="">
              <button type="button" onClick={pick} aria-label={`更换${label}`}>更换</button>
              <button type="button" onClick={() => void onUpload(kind, null)} aria-label={`移除${label}`}>移除</button>
            </span>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={ASSET_ACCEPT}
            hidden
            data-paper-chrome=""
            data-testid={`paper-asset-input-${kind}`}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] || null;
              event.currentTarget.value = "";
              if (file) void onUpload(kind, file);
            }}
          />
        </>
      )}
    </div>
  );
}

type FieldKey = string;
interface ItemShape {
  title: FieldKey;
  meta: FieldKey[];
  start?: FieldKey;
  end?: FieldKey;
  date?: FieldKey;
  description?: boolean;
  tags?: { category: FieldKey; items: FieldKey };
  /** Shown as Kami's ink-blue role chip right after the title (e.g. a project role). */
  chip?: FieldKey;
  titlePlaceholder: string;
  metaPlaceholders: string[];
}

const EXPERIENCE: ItemShape = {
  title: "company", meta: ["position", "location"], start: "startDate", end: "endDate", description: true,
  titlePlaceholder: "公司", metaPlaceholders: ["职位", "城市"],
};

const SHAPES: Record<string, ItemShape> = {
  education: {
    title: "school", meta: ["degree", "major", "gpa"], start: "startDate", end: "endDate", description: true,
    titlePlaceholder: "学校", metaPlaceholders: ["学历", "专业", "GPA"],
  },
  workExperiences: EXPERIENCE,
  experience: EXPERIENCE,
  internshipExperiences: EXPERIENCE,
  projects: {
    title: "name", meta: ["url"], chip: "role", start: "startDate", end: "endDate", description: true,
    titlePlaceholder: "项目名称", metaPlaceholders: ["链接"],
  },
  awards: {
    title: "awardName", meta: ["issuer"], date: "awardedAt", description: true,
    titlePlaceholder: "奖项", metaPlaceholders: ["颁发方"],
  },
  certificates: {
    title: "name", meta: ["scoreOrLevel", "issuer"], date: "date",
    titlePlaceholder: "证书", metaPlaceholders: ["分数 / 等级", "颁发方"],
  },
  skills: {
    title: "category", meta: [], tags: { category: "category", items: "items" },
    titlePlaceholder: "类别", metaPlaceholders: [],
  },
  personalExperiences: {
    title: "experienceTitle", meta: [], start: "startDate", end: "endDate", description: true,
    titlePlaceholder: "经历", metaPlaceholders: [],
  },
};
SHAPES.campusExperiences = { ...EXPERIENCE, titlePlaceholder: "学生组织 / 社团", metaPlaceholders: ["职务", "城市"] };
SHAPES.languages = {
  title: "category", meta: [], tags: { category: "category", items: "items" },
  titlePlaceholder: "语言", metaPlaceholders: [],
};
SHAPES.interests = {
  title: "category", meta: [], tags: { category: "category", items: "items" },
  titlePlaceholder: "类别", metaPlaceholders: [],
};
SHAPES.portfolio = {
  title: "name", meta: ["url"], start: "startDate", end: "endDate", description: true,
  titlePlaceholder: "作品名称", metaPlaceholders: ["链接"],
};
SHAPES.project = SHAPES.projects;
SHAPES.skill = SHAPES.skills;
SHAPES.certificate = SHAPES.certificates;
SHAPES.custom = SHAPES.personalExperiences;

const FALLBACK_SHAPE: ItemShape = {
  title: "title", meta: ["subtitle"], start: "startDate", end: "endDate", description: true,
  titlePlaceholder: "标题", metaPlaceholders: ["副标题"],
};

export function shapeFor(sectionType: string): ItemShape {
  return SHAPES[sectionType] || FALLBACK_SHAPE;
}

const CONTACT_FIELDS: Array<[string, string]> = [
  ["phone", "电话"],
  ["email", "邮箱"],
  ["wechat", "微信"],
  ["github", "GitHub"],
  ["website", "个人网站"],
];

export function bulletsToDescription(bullets: string[]) {
  const kept = bullets.map((item) => item.replace(/\u200b/g, "").trim()).filter((item) => plainBullet(item).trim());
  if (!kept.length) return "";
  return `<ul>${kept.map((item) => `<li><p>${richBulletToHtml(item)}</p></li>`).join("")}</ul>`;
}

export function editBullet(
  item: Record<string, any>,
  index: number,
  change: { text?: string; remove?: boolean; insertAfter?: boolean },
): Record<string, any> {
  const bullets = splitRichBullets(String(item.description || ""));
  const hidden = new Set<number>(
    Array.isArray(item.hidden_bullet_indexes) ? item.hidden_bullet_indexes.map(Number) : [],
  );
  let nextHidden = [...hidden];
  if (change.remove) {
    bullets.splice(index, 1);
    nextHidden = nextHidden.filter((value) => value !== index).map((value) => (value > index ? value - 1 : value));
  } else if (change.insertAfter) {
    bullets.splice(index + 1, 0, "");
    nextHidden = nextHidden.map((value) => (value > index ? value + 1 : value));
  } else if (typeof change.text === "string") {
    if (bullets[index] === change.text) return item;
    bullets[index] = change.text;
  }
  const next: Record<string, any> = { ...item, description: bulletsToDescription(bullets.length ? bullets : []) };
  if (change.insertAfter) {
    next.description = `<ul>${bullets.map((value) => `<li><p>${richBulletToHtml(value) || "\u200b"}</p></li>`).join("")}</ul>`;
  }
  if (Array.isArray(item.hidden_bullet_indexes) || nextHidden.length) next.hidden_bullet_indexes = nextHidden;
  return next;
}

function visibleBulletEntries(item: Record<string, any>) {
  const hidden = new Set<number>(
    Array.isArray(item.hidden_bullet_indexes) ? item.hidden_bullet_indexes.map(Number) : [],
  );
  return splitRichBullets(String(item.description || ""))
    .map((text, index) => ({ text: text.replace(/\u200b/g, ""), index }))
    .filter((entry) => !hidden.has(entry.index));
}

function printableBullets(item: Record<string, any>, editable: boolean) {
  const entries = visibleBulletEntries(item);
  return editable ? entries : entries.filter((entry) => plainBullet(entry.text).trim());
}

interface EditableProps {
  value: string;
  editable: boolean;
  placeholder: string;
  className?: string;
  label: string;
  multiline?: boolean;
  /** 允许加粗（⌘/Ctrl+B 或选中后的「B」按钮）；value 里用 BOLD_OPEN/BOLD_CLOSE 标记。 */
  rich?: boolean;
  onCommit: (value: string) => void;
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
  autoFocus?: boolean;
}

/** 把可编辑区域的 DOM 读回带加粗标记的纯文本；除加粗外的格式一律丢掉。 */
function serializeRich(root: Node): string {
  let out = "";
  const walk = (node: Node, bold: boolean) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent || "";
        out += bold ? BOLD_OPEN + text + BOLD_CLOSE : text;
        return;
      }
      if (!(child instanceof HTMLElement)) return;
      if (child.tagName === "BR") { out += " "; return; }
      const weight = Number.parseInt(child.style.fontWeight || "0", 10);
      const isBold = child.tagName === "B" || child.tagName === "STRONG" || weight >= 600 || child.style.fontWeight === "bold";
      walk(child, bold || isBold);
    });
  };
  walk(root, false);
  return normalizeBold(out.split(BOLD_CLOSE + BOLD_OPEN).join(""));
}

function RichText({ text }: { text: string }) {
  const parts = normalizeBold(text).split(new RegExp(`(${BOLD_OPEN}[^${BOLD_CLOSE}]*${BOLD_CLOSE})`));
  return (
    <>
      {parts.map((part, index) => part.startsWith(BOLD_OPEN)
        ? <strong key={index}>{part.slice(1, -1)}</strong>
        : <Fragment key={index}>{part}</Fragment>)}
    </>
  );
}

function Editable({ value, editable, placeholder, className = "", label, multiline = false, rich = false, onCommit, onEnter, onBackspaceEmpty, autoFocus }: EditableProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || document.activeElement === node) return;
    if (rich) {
      if (serializeRich(node) !== normalizeBold(value)) node.innerHTML = richBulletToHtml(value);
    } else if (node.textContent !== value) node.textContent = value;
  }, [value, rich]);
  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus();
  }, [autoFocus]);

  if (!editable) {
    if (!plainBullet(value)) return null;
    return <span className={className}>{rich ? <RichText text={value} /> : value}</span>;
  }

  const read = () => {
    const node = ref.current;
    if (!node) return "";
    return rich ? serializeRich(node) : node.textContent || "";
  };

  const commit = () => {
    const text = read().replace(/\u00a0/g, " ").replace(/\u200b/g, "");
    const normalized = multiline ? text.trim() : text.replace(/\s*\n\s*/g, " ").trim();
    if (normalized !== value) onCommit(normalized);
  };

  const revert = () => {
    if (!ref.current) return;
    if (rich) ref.current.innerHTML = richBulletToHtml(value);
    else ref.current.textContent = value;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (rich && (event.metaKey || event.ctrlKey) && ["b", "i", "u"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      if (event.key.toLowerCase() === "b") document.execCommand("bold");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      revert();
      ref.current?.blur();
      return;
    }
    if (event.key === "Enter" && !(multiline && event.shiftKey)) {
      event.preventDefault();
      commit();
      if (onEnter) onEnter();
      else ref.current?.blur();
      return;
    }
    if (event.key === "Backspace" && onBackspaceEmpty && !plainBullet(read()).trim()) {
      event.preventDefault();
      onBackspaceEmpty();
    }
  };

  // 粘贴一律按纯文本，避免把网页/Word 的格式带进简历。
  const onPaste = (event: ClipboardEvent<HTMLSpanElement>) => {
    if (!rich) return;
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
  };

  const shared = {
    ref,
    role: "textbox",
    "aria-label": label,
    "aria-multiline": multiline || undefined,
    suppressContentEditableWarning: true,
    spellCheck: false,
    "data-placeholder": placeholder,
    "data-paper-editable": "",
    className: `paper-editable ${className}`,
    onBlur: commit,
    onKeyDown,
  } as const;

  if (rich) {
    return <span {...shared} data-paper-rich="" contentEditable onPaste={onPaste} dangerouslySetInnerHTML={{ __html: richBulletToHtml(value) }} />;
  }
  return <span {...shared} contentEditable="plaintext-only">{value}</span>;
}

/** 在要点里选中文字时浮出的「B」按钮；不进入导出。 */
function BoldBubble() {
  const [state, setState] = useState<{ x: number; y: number; active: boolean } | null>(null);
  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setState(null); return; }
      const anchor = selection.anchorNode;
      const host = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest("[data-paper-rich]");
      if (!host) { setState(null); return; }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      setState({ x: rect.left + rect.width / 2, y: rect.top, active: document.queryCommandState("bold") });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);
  if (!state || typeof document === "undefined") return null;
  return createPortal(
    <button
      type="button"
      className={`paper-bold-bubble${state.active ? " is-active" : ""}`}
      data-paper-chrome=""
      aria-label="加粗"
      aria-pressed={state.active}
      title="加粗（⌘/Ctrl + B）"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(event) => {
        event.preventDefault();
        document.execCommand("bold");
        setState((prev) => (prev ? { ...prev, active: document.queryCommandState("bold") } : prev));
      }}
    >
      B
    </button>,
    document.body,
  );
}

function textOf(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join("、");
  return value == null ? "" : String(value);
}

function emptyItem(shape: ItemShape) {
  const item: Record<string, any> = { [shape.title]: "" };
  for (const key of shape.meta) item[key] = "";
  if (shape.description) item.description = "";
  if (shape.tags) item[shape.tags.items] = "";
  if (shape.chip) item[shape.chip] = "";
  return item;
}

function hasContent(item: Record<string, any>, shape: ItemShape) {
  const keys = [shape.title, ...shape.meta, shape.start, shape.end, shape.date, shape.tags?.items, shape.chip, "description"];
  return keys.some((key) => key && textOf(item[key]).replace(/<[^>]+>/g, "").trim());
}

/** 纸色：用户选过就按选的；没选时「清晰」默认白纸、「留白」默认暖纸。 */
export function resolvePaperTone(styleConfig: Record<string, string> | undefined): "white" | "parchment" {
  if (styleConfig?.paperTone === "white" || styleConfig?.paperTone === "parchment") return styleConfig.paperTone;
  return styleConfig?.paperStyle === "kami" ? "parchment" : "white";
}

export function ResumePaper(props: ResumePaperProps) {
  const {
    userName, summary, contactJson, sections, styleConfig,
    editable = false, onProfileChange, onSectionChange,
    photoUrl, logoUrl, onUploadAsset,
  } = props;
  const hasMedia = Boolean(photoUrl || logoUrl || (editable && onUploadAsset));
  const focusRef = useRef<string | null>(null);
  // 默认「清晰」样式（对标超级简历）：照片在左、联系方式带标签、校徽在右；「留白」是 Kami 风格。
  const cv = styleConfig.paperStyle !== "kami";
  const tone = resolvePaperTone(styleConfig);

  const contact = contactJson || {};
  const contactEntries = CONTACT_FIELDS.filter(([key]) => editable || contact[key]);
  const summaryText = summary ? summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";

  const updateItem = (section: PaperSection, index: number, next: Record<string, any>) => {
    const content = [...(section.content_json || [])];
    content[index] = next;
    onSectionChange?.({ ...section, content_json: content });
  };

  const visibleSections = [...sections]
    .filter((section) => section.visible !== false)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  return (
    <article className={`paper-sheet paper-${tone}${editable ? " paper-is-editable" : ""}`} data-paper-tone={tone}>
      <header className="paper-header">
        {cv && hasMedia && <PaperAsset kind="photo" url={photoUrl} editable={editable} onUpload={onUploadAsset} />}
        <div className="paper-header-name">
          <h1 className="paper-name">
            <Editable value={userName || ""} editable={editable} placeholder="你的名字" label="姓名"
              onCommit={(value) => onProfileChange?.({ user_name: value })} />
            {(editable || contact.nameEn) && (
              <span className="paper-alias">
                <Editable value={contact.nameEn || ""} editable={editable} placeholder="英文名" label="英文名"
                  onCommit={(value) => onProfileChange?.({ contact_json: { ...contact, nameEn: value } })} />
              </span>
            )}
          </h1>
        </div>
        <div className="paper-header-right">
          {(editable || contact.role) && (
            <p className="paper-role">
              <Editable value={contact.role || ""} editable={editable} placeholder="求职意向，如：后端开发实习生"
                label="求职意向" onCommit={(value) => onProfileChange?.({ contact_json: { ...contact, role: value } })} />
            </p>
          )}
          {contactEntries.length > 0 && (
            <p className="paper-contact">
              {contactEntries.map(([key, label], index) => (
                <Fragment key={key}>
                  {index > 0 && (editable || contact[key]) && <span className="paper-sep" aria-hidden>{cv ? "|" : "·"}</span>}
                  <span className="paper-contact-item">
                    {cv && <span className="paper-contact-label">{label}：</span>}
                    <Editable value={contact[key] || ""} editable={editable} placeholder={label} label={label}
                      onCommit={(value) => onProfileChange?.({ contact_json: { ...contact, [key]: value } })} />
                  </span>
                </Fragment>
              ))}
            </p>
          )}
          {(editable || contact.location) && (
            <p className="paper-location">
              <Editable value={contact.location || ""} editable={editable} placeholder="城市" label="城市"
                onCommit={(value) => onProfileChange?.({ contact_json: { ...contact, location: value } })} />
            </p>
          )}
        </div>
        {hasMedia && (
          <div className="paper-media">
            <PaperAsset kind="logo" url={logoUrl} editable={editable} onUpload={onUploadAsset} />
            {!cv && <PaperAsset kind="photo" url={photoUrl} editable={editable} onUpload={onUploadAsset} />}
          </div>
        )}
      </header>

      {(editable || summaryText) && (
        <section className="paper-section">
          <p className="paper-summary">
            <Editable value={summaryText} editable={editable} multiline placeholder="个人简介：两三句话说清你能为这个岗位带来什么"
              label="个人简介" onCommit={(value) => onProfileChange?.({ summary: value })} />
          </p>
        </section>
      )}

      {visibleSections.map((section) => {
        const shape = shapeFor(section.section_type);
        const items = (section.content_json || [])
          .map((item, index) => ({ item: item as Record<string, any>, index }))
          .filter(({ item }) => editable || hasContent(item, shape));
        if (!editable && items.length === 0) return null;
        return (
          <section key={section.id} className="paper-section" data-section-type={section.section_type} data-section-id={section.id}>
            <h2 className="paper-section-title">
              <Editable value={section.title || ""} editable={editable} placeholder="段落标题" label="段落标题"
                onCommit={(value) => onSectionChange?.({ ...section, title: value })} />
            </h2>
            <div className="paper-items">
              {items.map(({ item, index }) => (
                <PaperItem
                  key={`${section.id}-${index}`}
                  item={item}
                  shape={shape}
                  editable={editable}
                  focusKey={focusRef}
                  itemKey={`${section.id}-${index}`}
                  onChange={(next) => updateItem(section, index, next)}
                  onRemove={() => {
                    const content = [...(section.content_json || [])];
                    content.splice(index, 1);
                    onSectionChange?.({ ...section, content_json: content });
                  }}
                />
              ))}
            </div>
            {editable && (
              <button
                type="button"
                className="paper-add"
                data-paper-chrome=""
                onClick={() => onSectionChange?.({ ...section, content_json: [...(section.content_json || []), emptyItem(shape)] })}
              >
                + 添加一条{section.title ? `「${section.title}」` : ""}
              </button>
            )}
          </section>
        );
      })}
      {editable && <BoldBubble />}
    </article>
  );
}

function PaperItem({
  item, shape, editable, onChange, onRemove, focusKey, itemKey,
}: {
  item: Record<string, any>;
  shape: ItemShape;
  editable: boolean;
  onChange: (next: Record<string, any>) => void;
  onRemove: () => void;
  focusKey: { current: string | null };
  itemKey: string;
}) {
  const set = (key: string, value: string) => onChange({ ...item, [key]: value });
  const bullets = shape.description ? printableBullets(item, editable) : [];
  const metaParts = shape.meta.filter((key) => editable || textOf(item[key]));
  const hasDate = shape.date || shape.start || shape.end;

  if (shape.tags) {
    const tags = textOf(item[shape.tags.items]);
    return (
      <div className="paper-item paper-skill-row">
        <span className="paper-skill-category">
          <Editable value={textOf(item[shape.tags.category])} editable={editable} placeholder="类别" label="技能类别"
            onCommit={(value) => set(shape.tags!.category, value)} />
        </span>
        <span className="paper-skill-items">
          <Editable value={tags} editable={editable} placeholder="用顿号分隔，例如：Go、Kafka、MySQL" label="技能列表"
            onCommit={(value) => set(shape.tags!.items, value)} />
        </span>
        {editable && <RemoveItem onRemove={onRemove} />}
      </div>
    );
  }

  const renderMeta = (): ReactNode => metaParts.map((key, position) => {
    const placeholder = shape.metaPlaceholders[shape.meta.indexOf(key)] || "";
    return (
      <Fragment key={key}>
        {position > 0 && (editable || textOf(item[key])) && <span className="paper-sep" aria-hidden>·</span>}
        <Editable value={key === "gpa" && !editable && item[key] ? `GPA ${item[key]}` : textOf(item[key])}
          editable={editable} placeholder={placeholder} label={placeholder} onCommit={(value) => set(key, value)} />
      </Fragment>
    );
  });

  return (
    <div className="paper-item">
      <div className="paper-item-head">
        <div className="paper-item-main">
          <span className="paper-item-title">
            <Editable value={textOf(item[shape.title])} editable={editable} placeholder={shape.titlePlaceholder}
              label={shape.titlePlaceholder} onCommit={(value) => set(shape.title, value)} />
          </span>
          {shape.chip && (editable || textOf(item[shape.chip])) && (
            <span className="paper-chip">
              <Editable value={textOf(item[shape.chip])} editable={editable} placeholder="你的角色" label="角色"
                onCommit={(value) => set(shape.chip!, value)} />
            </span>
          )}
          {metaParts.length > 0 && <span className="paper-item-meta">{renderMeta()}</span>}
        </div>
        {hasDate && (
          <span className="paper-date">
            {shape.date ? (
              <Editable value={textOf(item[shape.date])} editable={editable} placeholder="日期" label="日期"
                onCommit={(value) => set(shape.date!, value)} />
            ) : (
              <>
                <Editable value={textOf(item[shape.start!])} editable={editable} placeholder="开始" label="开始时间"
                  onCommit={(value) => set(shape.start!, value)} />
                {(editable || (item[shape.start!] && item[shape.end!])) && <span aria-hidden> – </span>}
                <Editable value={textOf(item[shape.end!])} editable={editable} placeholder="至今" label="结束时间"
                  onCommit={(value) => set(shape.end!, value)} />
              </>
            )}
          </span>
        )}
        {editable && <RemoveItem onRemove={onRemove} />}
      </div>
      {(bullets.length > 0 || (editable && shape.description)) && (
        <ul className="paper-bullets">
          {bullets.map((entry, position) => {
            const key = `${itemKey}-b${entry.index}`;
            return (
              <li key={key}>
                <Editable
                  value={entry.text}
                  editable={editable}
                  multiline
                  rich
                  placeholder="动词开头，写清做了什么、结果是多少"
                  label="经历要点"
                  autoFocus={focusKey.current === key}
                  onCommit={(value) => onChange(editBullet(item, entry.index, { text: value }))}
                  onEnter={() => {
                    focusKey.current = `${itemKey}-b${entry.index + 1}`;
                    onChange(editBullet(item, entry.index, { insertAfter: true }));
                  }}
                  onBackspaceEmpty={() => {
                    const previous = bullets[position - 1];
                    focusKey.current = previous ? `${itemKey}-b${previous.index}` : null;
                    onChange(editBullet(item, entry.index, { remove: true }));
                  }}
                />
              </li>
            );
          })}
          {editable && bullets.length === 0 && (
            <li className="paper-bullet-empty" data-paper-chrome="">
              <button type="button" className="paper-add" onClick={() => {
                focusKey.current = `${itemKey}-b0`;
                onChange({ ...item, description: "<ul><li><p>\u200b</p></li></ul>" });
              }}>
                + 写一条要点
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function RemoveItem({ onRemove }: { onRemove: () => void }) {
  return (
    <button type="button" className="paper-remove" data-paper-chrome="" aria-label="删除这一条" onClick={onRemove}>
      删除
    </button>
  );
}

export default ResumePaper;
