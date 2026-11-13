import * as RadixPopover from "@radix-ui/react-popover";
import { Check, Plus, Tag as TagIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { cx } from "./cx";
import { type Tone, toneOf } from "./Pill";

// 标签 / 状态选择器（参考 Inspora · kian bazza「Morphing braille loader」）：
// 白色浮层顶上一行搜索；下面一行一个「色点 + 名字」，悬停 / 键盘高亮是浅灰圆角底；
// 勾选框只在悬停或已选时出现（已选 = 墨黑实心圆角方块 + 白勾）。
// 搜不到就出「创建标签：xxx」；创建时顶上的动词 创建 → 创建中 → 已创建，
// 同一个字形 标签图标 → 盲文点阵加载 → 对勾 就地变形，整块浮层变淡表示「正在处理」。

export type LabelOption = { value: string; label: string; tone: Tone; hint?: string };
export type LabelCreateState = "idle" | "creating" | "created";

/** 盲文点阵加载：2×4 个点轮流亮起，完成时点收起、对勾画出来。 */
export function BrailleLoader({ state, className }: { state: LabelCreateState; className?: string }) {
  return (
    <span className={cx("ou-braille", className)} data-state={state} aria-hidden>
      <span className="ou-braille-tag"><TagIcon size={14} strokeWidth={1.9} /></span>
      <span className="ou-braille-dots">
        {Array.from({ length: 8 }, (_, i) => <i key={i} style={{ ["--d" as string]: i }} />)}
      </span>
      <svg className="ou-braille-check" viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-7" pathLength={1} /></svg>
    </span>
  );
}

/** 标签 chip：色点 + 名字，和选择器里的行一个样子。 */
export function Tag({ tone, children, title, onClick }: { tone: Tone; children: ReactNode; title?: string; onClick?: () => void }) {
  const body = <><span className={`ou-tag-dot ou-tone-${tone}`} aria-hidden /><span className="truncate">{children}</span></>;
  return onClick
    ? <button type="button" className="ou-tag" title={title} onClick={onClick}>{body}</button>
    : <span className="ou-tag" title={title}>{body}</span>;
}

export function LabelPicker({
  trigger, options, value, onChange, multiple = true, onCreate, placeholder = "搜索或创建标签…", label, align = "start", side,
  createVerb = "创建标签",
}: {
  trigger: ReactNode;
  options: LabelOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** false：单选（状态），点一下就选中并关掉。 */
  multiple?: boolean;
  /** 有它才出现「创建标签：xxx」行；返回的 Promise 结束前显示加载。 */
  onCreate?: (name: string) => Promise<unknown> | void;
  placeholder?: string;
  label: string;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  createVerb?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [state, setState] = useState<LabelCreateState>("idle");
  const [pending, setPending] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const timer = useRef<number | null>(null);
  const baseId = useId();
  const q = query.trim();

  const rows = useMemo((): LabelOption[] => {
    const hit = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
    const exact = options.some((o) => o.label === q);
    const create = onCreate && q && !exact && multiple ? [{ value: "\u0000create", label: q, tone: toneOf(q) }] : [];
    return [...create, ...hit];
  }, [options, q, onCreate, multiple]);

  useEffect(() => { if (q) setActive(0); }, [q]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const create = async (name: string) => {
    if (!onCreate || state !== "idle") return;
    const tag = name.trim().slice(0, 20);
    if (!tag) return;
    setPending(tag);
    setState("creating");
    const started = Date.now();
    try {
      await onCreate(tag);
      // 加载至少露一下，免得一闪而过看不清发生了什么。
      await new Promise((r) => window.setTimeout(r, Math.max(0, 520 - (Date.now() - started))));
      setState("created");
      setQuery("");
      timer.current = window.setTimeout(() => { setState("idle"); setPending(""); }, 900);
    } catch {
      setState("idle");
      setPending("");
    }
  };

  const pick = (row: LabelOption) => {
    if (row.value === "\u0000create") { void create(row.label); return; }
    if (!multiple) { onChange([row.value]); setOpen(false); return; }
    onChange(value.includes(row.value) ? value.filter((v) => v !== row.value) : [...value, row.value]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (rows[active]) pick(rows[active]); }
    else if (e.key === "Backspace" && !query && multiple && value.length) { onChange(value.slice(0, -1)); }
  };

  const activeRow = rows[active];
  const previewTone: Tone = state !== "idle" ? toneOf(pending) : activeRow?.tone ?? "gray";
  const showHead = !!onCreate && (state !== "idle" || activeRow?.value === "\u0000create");
  const verb = state === "creating" ? "创建中" : state === "created" ? "已创建" : "创建";
  const headName = state !== "idle" ? pending : q;

  return (
    <RadixPopover.Root open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) setQuery("");
      else setActive(Math.max(0, options.findIndex((o) => value.includes(o.value))));
    }}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align={align} side={side} sideOffset={6} collisionPadding={12} aria-label={label}
          className="ou-floating ou-label-picker" data-busy={state === "creating" || undefined}
          onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).querySelector("input")?.focus(); }}>
          {showHead && (
            <div className="ou-label-head" aria-live="polite">
              <BrailleLoader state={state} />
              <span key={verb} className="ou-swap ou-label-verb">{verb}</span>
              <span className={`ou-tag-dot ou-tone-${previewTone}`} aria-hidden />
              <span className="ou-label-head-name truncate">{headName}</span>
            </div>
          )}
          <div className="ou-label-search">
            <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder={placeholder}
              aria-label={label} role="combobox" aria-expanded aria-controls={baseId} disabled={state === "creating"}
              aria-activedescendant={rows.length ? `${baseId}-${active}` : undefined} spellCheck={false} />
          </div>
          <ul ref={listRef} id={baseId} role="listbox" aria-multiselectable={multiple || undefined} className="ou-label-list">
            {rows.map((row, i) => {
              const isCreate = row.value === "\u0000create";
              const checked = !isCreate && value.includes(row.value);
              return (
                <li key={row.value} id={`${baseId}-${i}`} role="option" aria-selected={checked} data-index={i}
                  data-active={i === active || undefined} data-checked={checked || undefined}
                  onMouseMove={() => i !== active && setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(row)}
                  className="ou-label-row">
                  {isCreate ? (
                    <>
                      <Plus size={15} strokeWidth={1.9} className="ou-label-plus" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{createVerb}：<b>{row.label}</b></span>
                    </>
                  ) : (
                    <>
                      <span className={`ou-tag-dot ou-tone-${row.tone}`} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{row.label}</span>
                      {row.hint && <span className="ou-label-hint">{row.hint}</span>}
                      <span className="ou-label-check" aria-hidden>{checked && <Check size={12} strokeWidth={2.6} />}</span>
                    </>
                  )}
                </li>
              );
            })}
            {!rows.length && <li className="ou-label-empty">{onCreate ? "输入名字创建一个标签" : "没有匹配的选项"}</li>}
          </ul>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
