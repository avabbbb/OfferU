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

import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { splitBullets } from "@/lib/resumeText";

export interface PaperSection {
  id: number;
  section_type: string;
  title: string;
  visible: boolean;
  content_json: any[];
  sort_order: number;
  [key: string]: unknown;
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
}

/* ------------------------------------------------------------------ */
/* 字段映射：每种段落类型的「标题 / 副标题 / 机构 / 日期」对应哪些原始字段。 */
/* 画布只改这些原始字段，左侧表单、AI 建议和导出读的都是同一份数据。          */
/* ------------------------------------------------------------------ */

type FieldKey = string;
interface ItemShape {
  title: FieldKey;
  meta: FieldKey[];
  start?: FieldKey;
  end?: FieldKey;
  date?: FieldKey;
  description?: boolean;
  tags?: { category: FieldKey; items: FieldKey };
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
    title: "name", meta: ["role", "url"], start: "startDate", end: "endDate", description: true,
    titlePlaceholder: "项目名称", metaPlaceholders: ["角色", "链接"],
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
  ["location", "城市"],
  ["website", "个人网站"],
  ["github", "GitHub"],
  ["linkedin", "LinkedIn"],
];

/* ------------------------------------------------------------------ */
/* 要点（bullet）与 description 的互转。只在用户真的改了某条时才重写。     */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function bulletsToDescription(bullets: string[]) {
  const kept = bullets.map((item) => item.replace(/\u200b/g, "").trim()).filter(Boolean);
  if (!kept.length) return "";
  return `<ul>${kept.map((item) => `<li><p>${escapeHtml(item)}</p></li>`).join("")}</ul>`;
}

/** 把「第 index 条要点改成 text」应用到原始条目上；text 为 null 表示删除，insertAfter 表示在其后插入空行。 */
export function editBullet(
  item: Record<string, any>,
  index: number,
  change: { text?: string; remove?: boolean; insertAfter?: boolean },
): Record<string, any> {
  const bullets = splitBullets(String(item.description || ""));
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
    // 空要点只存在于界面上：先把描述按「含空行」的形式保存，避免 splitBullets 把它吞掉。
    next.description = `<ul>${bullets.map((value) => `<li><p>${escapeHtml(value) || "\u200b"}</p></li>`).join("")}</ul>`;
  }
  if (Array.isArray(item.hidden_bullet_indexes) || nextHidden.length) next.hidden_bullet_indexes = nextHidden;
  return next;
}

function visibleBulletEntries(item: Record<string, any>) {
  const hidden = new Set<number>(
    Array.isArray(item.hidden_bullet_indexes) ? item.hidden_bullet_indexes.map(Number) : [],
  );
  return splitBullets(String(item.description || ""))
    .map((text, index) => ({ text: text.replace(/\u200b/g, ""), index }))
    .filter((entry) => !hidden.has(entry.index));
}

function printableBullets(item: Record<string, any>, editable: boolean) {
  const entries = visibleBulletEntries(item);
  return editable ? entries : entries.filter((entry) => entry.text.trim());
}

/* ------------------------------------------------------------------ */
/* 可编辑文字：非受控 contentEditable，失焦或回车提交，Esc 还原。            */
/* ------------------------------------------------------------------ */

interface EditableProps {
  value: string;
  editable: boolean;
  placeholder: string;
  className?: string;
  label: string;
  multiline?: boolean;
  onCommit: (value: string) => void;
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
  autoFocus?: boolean;
}

function Editable({ value, editable, placeholder, className = "", label, multiline = false, onCommit, onEnter, onBackspaceEmpty, autoFocus }: EditableProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || document.activeElement === node) return;
    if (node.textContent !== value) node.textContent = value;
  }, [value]);
  useEffect(() => {
    if (autoFocus && ref.current) ref.current.focus();
  }, [autoFocus]);

  if (!editable) {
    return value ? <span className={className}>{value}</span> : null;
  }

  const commit = () => {
    const text = (ref.current?.textContent || "").replace(/\u00a0/g, " ").replace(/\u200b/g, "");
    const normalized = multiline ? text.trim() : text.replace(/\s*\n\s*/g, " ").trim();
    if (normalized !== value) onCommit(normalized);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (ref.current) ref.current.textContent = value;
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
    if (event.key === "Backspace" && onBackspaceEmpty && !(ref.current?.textContent || "").trim()) {
      event.preventDefault();
      onBackspaceEmpty();
    }
  };

  return (
    <span
      ref={ref}
      role="textbox"
      aria-label={label}
      aria-multiline={multiline || undefined}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder={placeholder}
      data-paper-editable=""
      className={`paper-editable ${className}`}
      onBlur={commit}
      onKeyDown={onKeyDown}
    >
      {value}
    </span>
  );
}

/* ------------------------------------------------------------------ */

function textOf(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean).join("、");
  return value == null ? "" : String(value);
}

function emptyItem(shape: ItemShape) {
  const item: Record<string, any> = { [shape.title]: "" };
  for (const key of shape.meta) item[key] = "";
  if (shape.description) item.description = "";
  if (shape.tags) item[shape.tags.items] = "";
  return item;
}

function hasContent(item: Record<string, any>, shape: ItemShape) {
  const keys = [shape.title, ...shape.meta, shape.start, shape.end, shape.date, shape.tags?.items, "description"];
  return keys.some((key) => key && textOf(item[key]).replace(/<[^>]+>/g, "").trim());
}

export function ResumePaper(props: ResumePaperProps) {
  const {
    userName, title = "", summary, contactJson, sections, styleConfig,
    editable = false, onProfileChange, onSectionChange,
  } = props;
  const focusRef = useRef<string | null>(null);
  const tone = styleConfig.paperTone === "white" ? "white" : "parchment";

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
        <h1 className="paper-name">
          <Editable value={userName || ""} editable={editable} placeholder="你的名字" label="姓名"
            onCommit={(value) => onProfileChange?.({ user_name: value })} />
        </h1>
        {(editable || title) && (
          <p className="paper-headline">
            <Editable value={title} editable={editable} placeholder="一句话定位，比如：后端工程师 · 3 年支付系统"
              label="求职定位" onCommit={(value) => onProfileChange?.({ title: value })} />
          </p>
        )}
        {contactEntries.length > 0 && (
          <p className="paper-contact">
            {contactEntries.map(([key, label], index) => (
              <Fragment key={key}>
                {index > 0 && (editable || contact[key]) && <span className="paper-sep" aria-hidden>·</span>}
                <Editable value={contact[key] || ""} editable={editable} placeholder={label} label={label}
                  onCommit={(value) => onProfileChange?.({ contact_json: { ...contact, [key]: value } })} />
              </Fragment>
            ))}
          </p>
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
          <section key={section.id} className="paper-section" data-section-type={section.section_type}>
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

