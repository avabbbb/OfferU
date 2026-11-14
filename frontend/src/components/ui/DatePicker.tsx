import * as RadixPopover from "@radix-ui/react-popover";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Button } from "./Button";
import { cx } from "./cx";
import { Select } from "./Select";

// 日期 / 日期时间选择：替代原生 <input type="date" | "datetime-local">（系统弹层不跟玻璃风格、深色下发白、中文格式不统一）。
// 触发器同 Input；浮层是和 Popover 同一块浅色玻璃：月份标题 + ‹ › → 周一开头的 6×7 日期格 → 可选「时 : 分」两个 Select → 清除 / 今天。
// 值的格式与原生控件一致（YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，空串 = 未填），可以直接替换。
// 今天是橙色（和周日历一致），选中是墨黑实心；方向键在日期格里走（←→ 一天，↑↓ 一周），回车选中。

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 把 YYYY-MM-DD[THH:mm] 拆成本地日期和时间；不合法就当没填。 */
export function parseDateValue(value: string | null | undefined): { date: Date | null; time: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value ?? "");
  if (!m) return { date: null, time: "" };
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(date.getTime())) return { date: null, time: "" };
  return { date, time: m[4] ? `${m[4]}:${m[5]}` : "" };
}

/** 某月的 6×7 日期格：从包含 1 号那一周的周一开始。 */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

/** 触发器上的文字：11月16日 周一 14:00；不是今年就带上年份。 */
export function formatDateValue(value: string, now = new Date()): string {
  const { date, time } = parseDateValue(value);
  if (!date) return "";
  const year = date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY[date.getDay()]}${time ? ` ${time}` : ""}`;
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: pad(h), label: pad(h) }));
const MINUTES = ["00", "15", "30", "45"];

export function DatePicker({
  value, onChange, withTime = false, placeholder, id, "aria-label": ariaLabel, size, className, defaultTime = "09:00",
  defaultOpen = false, onOpenChange,
}: {
  value: string;
  onChange: (value: string) => void;
  /** true：日期 + 时间（YYYY-MM-DDTHH:mm），选完日期浮层不关，可以接着调时间。 */
  withTime?: boolean;
  placeholder?: string;
  id?: string;
  "aria-label"?: string;
  /** sm：工具栏 / 浮层里的紧凑版（28px 胶囊），同 Select。 */
  size?: "sm";
  className?: string;
  /** 只选了日期时补的时间。 */
  defaultTime?: string;
  /** 挂载即打开：表格单元格双击进入编辑时用。 */
  defaultOpen?: boolean;
  /** 浮层开合（含选完日期自动关）都会通知；单元格据此退出编辑态。 */
  onOpenChange?: (open: boolean) => void;
}) {
  const { date, time } = parseDateValue(value);
  const [open, setOpenState] = useState(defaultOpen);
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  const [cursor, setCursor] = useState<Date>(() => date ?? new Date());
  const gridRef = useRef<HTMLDivElement>(null);
  const today = ymd(new Date());
  const selected = date ? ymd(date) : "";
  const [hour, minute] = (time || defaultTime).split(":");

  // 每次打开都从已选日期（或今天）那个月开始。
  useEffect(() => { if (open) setCursor(date ?? new Date()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) gridRef.current?.querySelector<HTMLElement>(`[data-day="${ymd(cursor)}"]`)?.focus({ preventScroll: true });
  }, [open, cursor]);

  const emit = (day: Date, t = time || defaultTime) => onChange(withTime ? `${ymd(day)}T${t}` : ymd(day));
  const pick = (day: Date) => {
    emit(day);
    if (!withTime) setOpen(false);
  };
  const shift = (days: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth(), c.getDate() + days));
  const shiftMonth = (months: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + months, 1));
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) { e.preventDefault(); shift(step[e.key]); }
    else if (e.key === "PageUp" || e.key === "PageDown") { e.preventDefault(); shiftMonth(e.key === "PageUp" ? -1 : 1); }
  };
  const minuteOptions = (MINUTES.includes(minute) ? MINUTES : [...MINUTES, minute].sort()).map((m) => ({ value: m, label: m }));
  const days = monthGrid(cursor.getFullYear(), cursor.getMonth());
  const label = formatDateValue(value);

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <button type="button" id={id} aria-label={ariaLabel} title={label || undefined}
          className={cx("ou-input ou-date-trigger", size === "sm" && "ou-input-sm", className)}>
          <Calendar size={14} strokeWidth={1.8} aria-hidden />
          <span className={cx("truncate", !label && "ou-date-placeholder")}>{label || placeholder || (withTime ? "选日期和时间" : "选日期")}</span>
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content align="start" sideOffset={6} collisionPadding={12} aria-label={ariaLabel ?? "选日期"}
          className="ou-floating ou-popover ou-date-picker" onOpenAutoFocus={(e) => e.preventDefault()}>
          <div className="ou-date-head">
            <span className="ou-date-month" aria-live="polite">{cursor.getFullYear()} 年 {cursor.getMonth() + 1} 月</span>
            <span className="ou-button-group">
              <button type="button" className="ou-icon-button" aria-label="上个月" onClick={() => shiftMonth(-1)}><ChevronLeft size={16} aria-hidden /></button>
              <button type="button" className="ou-icon-button" aria-label="下个月" onClick={() => shiftMonth(1)}><ChevronRight size={16} aria-hidden /></button>
            </span>
          </div>
          <div ref={gridRef} className="ou-date-grid" role="grid" aria-label="日期" onKeyDown={onGridKey}>
            {WEEK.map((w) => <span key={w} className="ou-date-weekday" aria-hidden>{w}</span>)}
            {days.map((day) => {
              const key = ymd(day);
              const isCursor = key === ymd(cursor);
              return (
                <button key={key} type="button" data-day={key} tabIndex={isCursor ? 0 : -1}
                  aria-label={`${day.getMonth() + 1}月${day.getDate()}日 ${WEEKDAY[day.getDay()]}`} aria-pressed={key === selected}
                  data-today={key === today || undefined} data-selected={key === selected || undefined}
                  data-outside={day.getMonth() !== cursor.getMonth() || undefined}
                  className="ou-date-day" onClick={() => { setCursor(day); pick(day); }}>
                  {day.getDate()}
                </button>
              );
            })}
          </div>
          {withTime && (
            <div className="ou-date-time">
              <span className="ou-date-time-label">时间</span>
              <Select size="sm" aria-label="小时" value={hour} options={HOURS}
                onValueChange={(h) => emit(date ?? cursor, `${h}:${minute}`)} />
              <span aria-hidden>:</span>
              <Select size="sm" aria-label="分钟" value={minute} options={minuteOptions}
                onValueChange={(m) => emit(date ?? cursor, `${hour}:${m}`)} />
            </div>
          )}
          <div className="ou-date-foot">
            <Button size="sm" variant="ghost" disabled={!value} onClick={() => { onChange(""); setOpen(false); }}>清除</Button>
            <Button size="sm" variant="ghost" onClick={() => { const now = new Date(); setCursor(now); pick(now); }}>今天</Button>
            {withTime && <Button size="sm" className="ml-auto" onClick={() => setOpen(false)}>完成</Button>}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
