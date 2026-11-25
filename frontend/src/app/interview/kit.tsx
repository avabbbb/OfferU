"use client";

// 面试页共用的小件：披露、带共享白胶囊的选项 / 分段、步骤切换。样式在 styles/interview.css。

import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion, type Transition } from "framer-motion";
import { ChevronDown } from "lucide-react";
import "@/styles/interview.css";

/** 接近 iOS 的柔和弹簧：不明显回弹。 */
export const SPRING: Transition = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 };

export function Disclosure({ title, summary, icon, defaultOpen = false, tone, children, testId }: {
  title: ReactNode;
  summary?: ReactNode;
  icon?: ReactNode;
  defaultOpen?: boolean;
  tone?: "paper";
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="iv-disclosure" data-open={open ? "" : undefined} data-tone={tone} data-testid={testId}>
      <button type="button" className="iv-disclosure-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
        {icon}
        <span className="min-w-0 truncate">{title}</span>
        {summary && !open && <span className="iv-disclosure-summary">{summary}</span>}
        <ChevronDown size={16} className={`iv-disclosure-chevron ${summary && !open ? "" : "ml-auto"}`} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            key="body"
            className="iv-disclosure-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING}
          >
            <div className="iv-disclosure-inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 卡片式单选：选中的白胶囊在选项间滑动（layoutId）。 */
export function OptionCards<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string; detail?: string }[];
  onChange: (value: T) => void;
}) {
  const group = useId();
  return (
    <div className="iv-options" role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={active} className="iv-option" onClick={() => onChange(option.value)}>
            {active && <motion.span layoutId={`${group}-hl`} className="iv-highlight" transition={SPRING} aria-hidden="true" />}
            <span className="iv-option-title">{option.label}</span>
            {option.detail && <span className="iv-option-detail">{option.detail}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** 分段：一条轨道，选中项是一颗滑动的白胶囊。 */
export function Segmented<T extends string | number>({ label, value, options, onChange, inline }: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  inline?: boolean;
}) {
  const group = useId();
  return (
    <div className={`iv-seg${inline ? " iv-seg-inline" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button key={String(option.value)} type="button" role="radio" aria-checked={active} className="iv-seg-item" onClick={() => onChange(option.value)}>
            {active && <motion.span layoutId={`${group}-hl`} className="iv-highlight" transition={SPRING} aria-hidden="true" />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 步骤切换：前进从右滑入，后退从左滑入，同时淡入淡出。 */
export function StepSwitch({ step, direction, children }: { step: string | number; direction: 1 | -1; children: ReactNode }) {
  return (
    <div className="iv-step-host">
      <AnimatePresence mode="wait" initial={false} custom={direction}>
        <motion.div
          key={step}
          custom={direction}
          variants={{
            enter: (dir: number) => ({ x: dir * 32, opacity: 0 }),
            center: { x: 0, opacity: 1 },
            exit: (dir: number) => ({ x: dir * -32, opacity: 0 }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={SPRING}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** 进场：上浮 + 淡入，用在反馈、报告分组这些「之后才出现」的东西上。 */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay }}>
      {children}
    </motion.div>
  );
}
