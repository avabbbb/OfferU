"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";

interface CascadeDatePickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function parseDate(v: string) {
  if (!v) return { year: "", month: "", day: "" };
  const datePart = v.split("T")[0] || "";
  const [year = "", month = "", day = ""] = datePart.split("-");
  return { year, month, day };
}

export default function CascadeDatePicker({ label, value, onChange }: CascadeDatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [sel, setSel] = useState({ year: "", month: "", day: "" });
  const containerRef = useRef<HTMLDivElement>(null);
  const yearColRef = useRef<HTMLDivElement>(null);
  const monthColRef = useRef<HTMLDivElement>(null);
  const dayColRef = useRef<HTMLDivElement>(null);

  const parts = parseDate(value);
  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 100 }, (_, i) => String(currentYear - 50 + i));
  const monthOptions = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));

  const getDaysInMonth = (year: string, month: string) => {
    if (!year || !month) return 31;
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 31;
    return new Date(y, m, 0).getDate();
  };

  const dayOptions = Array.from(
    { length: getDaysInMonth(sel.year, sel.month) },
    (_, i) => String(i + 1).padStart(2, "0")
  );

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const dateStage = !sel.year ? 0 : !sel.month ? 1 : 2;

  const scrollToSelected = (colRef: React.RefObject<HTMLDivElement | null>, selector: string) => {
    if (!colRef.current) return;
    const selected = colRef.current.querySelector(selector);
    if (selected) {
      selected.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => {
      if (sel.year) {
        scrollToSelected(yearColRef, '[data-selected="true"]');
      } else {
        const currentYearBtn = yearColRef.current?.querySelector(`[data-year="${currentYear}"]`);
        if (currentYearBtn) {
          currentYearBtn.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        }
      }
    });
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && sel.month) {
      requestAnimationFrame(() => scrollToSelected(monthColRef, '[data-selected="true"]'));
    }
  }, [isOpen, sel.month]);

  useEffect(() => {
    if (isOpen && sel.day) {
      requestAnimationFrame(() => scrollToSelected(dayColRef, '[data-selected="true"]'));
    }
  }, [isOpen, sel.day]);

  const handleToggle = () => {
    const next = !isOpen;
    setIsOpen(next);
    if (next) {
      setSel({ year: parts.year, month: parts.month, day: parts.day });
    }
  };

  const handleYearClick = (y: string) => {
    setSel({ year: y, month: "", day: "" });
  };

  const handleMonthClick = (m: string) => {
    setSel((prev) => ({ ...prev, month: m, day: "" }));
  };

  const handleDayClick = (d: string) => {
    const dateStr = `${sel.year}-${sel.month}-${d}`;
    const timePart = value.includes("T") ? value.split("T")[1] : "";
    const fullValue = timePart ? `${dateStr}T${timePart}` : dateStr;
    onChange(fullValue);
    setIsOpen(false);
  };

  const displayValue = () => {
    if (!parts.year) return "";
    return `${parts.year}-${parts.month || "--"}-${parts.day || "--"}`;
  };

  return (
    <div ref={containerRef} className="relative">
      <label className="mb-1.5 block font-bold uppercase tracking-[0.14em] text-[11px] text-[var(--foreground-muted)]">
        {label}
      </label>
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center justify-between border border-[var(--border-strong)] bg-white px-3 py-2.5  transition-all hover:"
      >
        <span className={`text-sm font-medium ${displayValue() ? "text-[var(--foreground)]" : "text-[var(--foreground-muted)]"}`}>
          {displayValue() || `閫夋嫨${label}`}
        </span>
        <ChevronDown size={16} className={`text-[var(--foreground-muted)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 border border-[var(--border-strong)] bg-white ">
          <div className="flex h-52">
            <div
              className="h-full overflow-hidden border-r border-[var(--border)]"
              style={{
                width: dateStage === 0 ? "100%" : "33.33%",
                flex: "none",
                transition: "width 300ms var(--ease-snap)",
              }}
            >
              <div ref={yearColRef} className="h-full overflow-y-auto">
                <div className="sticky top-0 z-10 bg-[var(--surface-muted)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--foreground-muted)]">
                  骞?
                </div>
                {yearOptions.map((y) => (
                  <button
                    key={y}
                    type="button"
                    data-year={y}
                    data-selected={sel.year === y ? "true" : undefined}
                    onClick={() => handleYearClick(y)}
                    className={`block w-full px-3 py-2 text-left text-sm font-medium transition-colors ${
                      sel.year === y
                        ? "bg-[var(--surface-hover)] font-bold text-[var(--foreground)]"
                        : "text-[var(--foreground-soft)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    {y}
                  </button>
                ))}
              </div>
            </div>

            <div
              className="h-full overflow-hidden border-r border-[var(--border)]"
              style={{
                width: dateStage === 1 ? "66.67%" : dateStage === 2 ? "33.33%" : "0%",
                flex: "none",
                opacity: dateStage >= 1 ? 1 : 0,
                transition: "width 300ms var(--ease-snap), opacity 300ms var(--ease-snap)",
              }}
            >
              <div ref={monthColRef} className="h-full overflow-y-auto">
                <div className="sticky top-0 z-10 bg-[var(--surface-muted)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--foreground-muted)]">
                  鏈?
                </div>
                {monthOptions.map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-selected={sel.month === m ? "true" : undefined}
                    onClick={() => handleMonthClick(m)}
                    className={`block w-full px-3 py-2 text-left text-sm font-medium transition-colors ${
                      sel.month === m
                        ? "bg-[var(--surface-hover)] font-bold text-[var(--foreground)]"
                        : "text-[var(--foreground-soft)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div
              className="h-full overflow-hidden"
              style={{
                width: dateStage === 2 ? "33.34%" : "0%",
                flex: "none",
                opacity: dateStage >= 2 ? 1 : 0,
                transition: "width 300ms var(--ease-snap), opacity 300ms var(--ease-snap)",
              }}
            >
              <div ref={dayColRef} className="h-full overflow-y-auto">
                <div className="sticky top-0 z-10 bg-[var(--surface-muted)] px-2 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--foreground-muted)]">
                  鏃?
                </div>
                {dayOptions.map((d) => (
                  <button
                    key={d}
                    type="button"
                    data-selected={sel.day === d ? "true" : undefined}
                    onClick={() => handleDayClick(d)}
                    className={`block w-full px-3 py-2 text-left text-sm font-medium transition-colors ${
                      sel.day === d
                        ? "bg-[var(--surface-hover)] font-bold text-[var(--foreground)]"
                        : "text-[var(--foreground-soft)] hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
