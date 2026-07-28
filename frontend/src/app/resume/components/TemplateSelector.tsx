"use client";

import { Button, Popover, PopoverContent, PopoverTrigger } from "@nextui-org/react";
import { Check, LayoutTemplate } from "lucide-react";
import { TEMPLATE_OPTIONS, type ResumeTemplateType } from "./templates/templateSettings";

export default function TemplateSelector({
  value,
  onChange,
}: {
  value: ResumeTemplateType;
  onChange: (template: ResumeTemplateType) => void;
}) {
  const active = TEMPLATE_OPTIONS.find((template) => template.id === value) || TEMPLATE_OPTIONS[0];

  return (
    <Popover placement="bottom-start">
      <PopoverTrigger>
        <Button
          variant="light"
          size="sm"
          data-testid="resume-template-trigger"
          className="h-10 gap-2 rounded-none border border-[var(--border-strong)] bg-white px-3 text-[var(--foreground)] shadow-[2px_2px_0_0_rgba(18,18,18,0.3)] transition-all hover:-translate-y-[1px] data-[open=true]:bg-[#f5f5f5]"
        >
          <LayoutTemplate size={14} />
          <span className="max-w-[96px] truncate text-[11px] font-semibold">{active.name}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="resume-template-popover"
        className="w-72 rounded-none border border-[var(--border-strong)] bg-white p-2 text-[var(--foreground)] shadow-[4px_4px_0_0_rgba(18,18,18,0.32)]"
      >
        <div className="w-full">
          <div className="border-b border-[var(--border-strong)] pb-2">
            <p className="text-[12px] font-black">选择简历模板</p>
            <p className="mt-0.5 text-[11px] text-[var(--foreground)]">默认使用你给的 PDF 同款样式。</p>
          </div>
          <div className="mt-2 space-y-1">
            {TEMPLATE_OPTIONS.map((template) => {
              const selected = template.id === active.id;
              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => onChange(template.id)}
                  className={`flex w-full items-start gap-3 border px-3 py-2 text-left transition-colors ${
                    selected ? "border-[var(--border-strong)] bg-[#f3f3f3]" : "border-transparent hover:border-[var(--border-strong)]"
                  }`}
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border border-[var(--border-strong)]">
                    {selected && <Check size={12} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-bold">{template.name}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-[var(--foreground)]">{template.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
