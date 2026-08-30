"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Input, Button, Textarea } from "@nextui-org/react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, Eye, EyeOff, Plus, Trash2, GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import RichTextEditor from "./RichTextEditor";
import { reorderBullets, splitBullets } from "@/lib/resumeText";

const inputStyle = {
  inputWrapper:
    "border border-[var(--border-strong)]/15 bg-[var(--surface)] shadow-[1px_1px_0_0_rgba(18,18,18,0.08)] group-data-[focus=true]:border-[var(--border-strong)]/35",
  input: "font-medium text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]",
  label: "font-semibold tracking-[0.06em] text-[11px] text-[var(--foreground-muted)]",
  description: "text-[var(--foreground-muted)]",
  errorMessage: "font-medium text-[#D02020]",
};

interface SectionEditorProps {
  sectionType: string;
  contentJson: any[];
  onChange: (newContent: any[]) => void;
}

export function createEmptySectionItem(sectionType: string) {
  const templates: Record<string, any> = {
    education: { school: "", degree: "", major: "", gpa: "", startDate: "", endDate: "", description: "" },
    workExperiences: { company: "", position: "", startDate: "", endDate: "", description: "" },
    internshipExperiences: { company: "", position: "", startDate: "", endDate: "", description: "" },
    projects: { name: "", role: "", url: "", startDate: "", endDate: "", description: "" },
    skills: { category: "", items: [], remark: "" },
    certificates: { name: "", scoreOrLevel: "", issuer: "", date: "", url: "" },
    awards: { awardName: "", issuer: "", awardedAt: "", description: "" },
    personalExperiences: { experienceTitle: "", startDate: "", endDate: "", description: "" },
  };
  return templates[sectionType] || { experienceTitle: "", description: "" };
}

function sectionItemTitle(sectionType: string, item: any, index: number): string {
  if (sectionType === "education") return item.school || `教育条目 ${index + 1}`;
  if (sectionType === "workExperiences") return item.company || item.position || `工作条目 ${index + 1}`;
  if (sectionType === "internshipExperiences") return item.company || item.position || `实习条目 ${index + 1}`;
  if (sectionType === "projects") return item.name || `项目条目 ${index + 1}`;
  if (sectionType === "skills") return item.category || `技能条目 ${index + 1}`;
  if (sectionType === "certificates") return item.name || `证书条目 ${index + 1}`;
  if (sectionType === "awards") return item.awardName || `获奖条目 ${index + 1}`;
  return item.experienceTitle || `条目 ${index + 1}`;
}

function addButtonLabel(sectionType: string): string {
  if (sectionType === "education") return "添加教育经历";
  if (sectionType === "workExperiences") return "添加工作经历";
  if (sectionType === "internshipExperiences") return "添加实习经历";
  if (sectionType === "projects") return "添加项目经历";
  if (sectionType === "skills") return "添加技能条目";
  if (sectionType === "certificates") return "添加证书条目";
  if (sectionType === "awards") return "添加获奖条目";
  return "添加个人经历";
}

function BulletControls({ item, onChange }: { item: any; onChange: (next: any) => void }) {
  const bullets = splitBullets(String(item.description || ""));
  if (!bullets.length) return null;
  const hidden = new Set<number>(
    Array.isArray(item.hidden_bullet_indexes)
      ? item.hidden_bullet_indexes.map((value: unknown) => Number(value)).filter(Number.isInteger)
      : [],
  );
  const toggle = (index: number) => {
    const next = hidden.has(index)
      ? [...hidden].filter((value) => value !== index)
      : [...hidden, index];
    onChange({ ...item, hidden_bullet_indexes: next.sort((a, b) => a - b) });
  };
  const move = (from: number, to: number) => {
    const next = reorderBullets(item.description || "", [...hidden], from, to);
    onChange({ ...item, description: next.description, hidden_bullet_indexes: next.hiddenBulletIndexes });
  };

  return (
    <div className="rounded-lg border border-dashed border-[var(--border-strong)]/20 bg-[var(--surface)] p-2" data-testid="resume-bullet-controls">
      <p className="mb-1.5 text-[10px] font-bold text-[var(--foreground-muted)]">简历中显示的要点</p>
      <div className="space-y-1">
        {bullets.map((bullet, index) => (
          <div key={`${index}-${bullet}`} className="flex items-center gap-1.5 text-[10px]" data-testid={`resume-bullet-${index}`}>
            <button
              type="button"
              onClick={() => toggle(index)}
              aria-label={hidden.has(index) ? `显示要点 ${index + 1}` : `隐藏要点 ${index + 1}`}
              className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left ${hidden.has(index) ? "text-[var(--foreground-muted)] line-through" : "text-[var(--foreground)]"}`}
              data-testid={`resume-bullet-toggle-${index}`}
            >
              {hidden.has(index) ? <EyeOff size={11} /> : <Eye size={11} />}
              <span className="truncate">{bullet}</span>
            </button>
            <button type="button" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label={`上移要点 ${index + 1}`} className="rounded p-1 hover:bg-black/5 disabled:opacity-30"><ArrowUp size={11} /></button>
            <button type="button" onClick={() => move(index, index + 1)} disabled={index === bullets.length - 1} aria-label={`下移要点 ${index + 1}`} className="rounded p-1 hover:bg-black/5 disabled:opacity-30"><ArrowDown size={11} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DraggableListItem({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 30 : "auto",
  };

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="拖拽条目排序"
        className="absolute left-0 top-3 z-10 flex h-8 w-6 cursor-grab items-center justify-center text-[var(--foreground-muted)] active:cursor-grabbing"
      >
        <GripVertical size={13} aria-hidden="true" />
      </button>
      <div className="pl-5">{children}</div>
    </div>
  );
}

export default function SectionEditor({
  sectionType,
  contentJson,
  onChange,
}: SectionEditorProps) {
  const [collapsedItems, setCollapsedItems] = useState<Set<number>>(new Set());

  useEffect(() => {
    setCollapsedItems((prev) => {
      const next = new Set<number>();
      for (const index of prev) {
        if (index >= 0 && index < contentJson.length) next.add(index);
      }
      return next;
    });
  }, [contentJson.length]);

  const itemCount = useMemo(() => contentJson.length, [contentJson.length]);
  const itemIds = useMemo(
    () => contentJson.map((_, index) => `resume-${sectionType}-item-${index}`),
    [contentJson.length, sectionType],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleItemDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = itemIds.indexOf(String(active.id));
    const newIndex = itemIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const collapsedState = arrayMove(
      contentJson.map((_, index) => collapsedItems.has(index)),
      oldIndex,
      newIndex,
    );
    setCollapsedItems(new Set(collapsedState.flatMap((isCollapsed, index) => (isCollapsed ? [index] : []))));
    onChange(arrayMove(contentJson, oldIndex, newIndex));
  };

  const toggleItem = (index: number) => {
    setCollapsedItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const updateItem = (index: number, field: string, value: any) => {
    const arr = [...contentJson];
    arr[index] = { ...arr[index], [field]: value };
    onChange(arr);
  };

  const addItem = () => onChange([...contentJson, createEmptySectionItem(sectionType)]);
  const removeItem = (index: number) => onChange(contentJson.filter((_, i) => i !== index));

  return (
    <div className="space-y-2.5">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleItemDragEnd}>
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {contentJson.map((item, i) => (
            <DraggableListItem key={itemIds[i]} id={itemIds[i]}>
        <div
          className="bauhaus-panel-sm space-y-2.5 bg-[var(--surface-muted)] p-3"
          data-testid={`resume-item-${sectionType}-${i}`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GripVertical size={12} className="cursor-grab text-[var(--foreground-muted)]" />
              <span className="font-mono text-[10px] text-[var(--foreground-muted)]">#{i + 1}</span>
              <span className="max-w-[160px] truncate text-[11px] font-semibold tracking-[0.04em] text-[var(--foreground-muted)]">
                {sectionItemTitle(sectionType, item, i)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="light"
                className="bauhaus-button bauhaus-button-outline !h-8 !px-3 !py-2 !text-[10px]"
                onPress={() => toggleItem(i)}
                data-testid={`resume-item-toggle-${sectionType}-${i}`}
              >
                {collapsedItems.has(i) ? (
                  <span className="flex items-center gap-1"><ChevronDown size={11} />展开</span>
                ) : (
                  <span className="flex items-center gap-1"><ChevronUp size={11} />折叠</span>
                )}
              </Button>
              <Button
                size="sm"
                variant="light"
                isIconOnly
                onPress={() => removeItem(i)}
                aria-label="删除条目"
                data-testid={`resume-item-delete-${sectionType}-${i}`}
                className="bauhaus-button bauhaus-button-red !h-8 !min-w-8 !w-8 !px-0 !py-0"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {!collapsedItems.has(i) && (
              <motion.div
                key={`${sectionType}-${i}-body`}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="overflow-hidden space-y-2.5"
              >
                {sectionType === "education" && (
                  <>
                    <Input label="学校" variant="bordered" size="sm" value={item.school || ""} onValueChange={(v) => updateItem(i, "school", v)} classNames={inputStyle} />
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="学位" variant="bordered" size="sm" value={item.degree || ""} onValueChange={(v) => updateItem(i, "degree", v)} classNames={inputStyle} />
                      <Input label="专业" variant="bordered" size="sm" value={item.major || ""} onValueChange={(v) => updateItem(i, "major", v)} classNames={inputStyle} />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Input label="起始" variant="bordered" size="sm" value={item.startDate || ""} onValueChange={(v) => updateItem(i, "startDate", v)} classNames={inputStyle} />
                      <Input label="结束" variant="bordered" size="sm" value={item.endDate || ""} onValueChange={(v) => updateItem(i, "endDate", v)} classNames={inputStyle} />
                      <Input label="GPA" variant="bordered" size="sm" value={item.gpa || ""} onValueChange={(v) => updateItem(i, "gpa", v)} classNames={inputStyle} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">描述</label>
                      <RichTextEditor content={item.description || ""} onChange={(v) => updateItem(i, "description", v)} minHeight={80} placeholder="补充说明（可选）" />
                      <BulletControls item={item} onChange={(next) => { const arr = [...contentJson]; arr[i] = next; onChange(arr); }} />
                    </div>
                  </>
                )}

                {sectionType === "workExperiences" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="公司" variant="bordered" size="sm" value={item.company || ""} onValueChange={(v) => updateItem(i, "company", v)} classNames={inputStyle} />
                      <Input label="职位" variant="bordered" size="sm" value={item.position || ""} onValueChange={(v) => updateItem(i, "position", v)} classNames={inputStyle} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="起始" variant="bordered" size="sm" value={item.startDate || ""} onValueChange={(v) => updateItem(i, "startDate", v)} classNames={inputStyle} />
                      <Input label="结束" variant="bordered" size="sm" value={item.endDate || ""} onValueChange={(v) => updateItem(i, "endDate", v)} classNames={inputStyle} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">工作描述</label>
                      <RichTextEditor content={item.description || ""} onChange={(v) => updateItem(i, "description", v)} placeholder="描述你的工作职责和成果..." />
                      <BulletControls item={item} onChange={(next) => { const arr = [...contentJson]; arr[i] = next; onChange(arr); }} />
                    </div>
                  </>
                )}

                {sectionType === "internshipExperiences" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="公司" variant="bordered" size="sm" value={item.company || ""} onValueChange={(v) => updateItem(i, "company", v)} classNames={inputStyle} />
                      <Input label="岗位" variant="bordered" size="sm" value={item.position || ""} onValueChange={(v) => updateItem(i, "position", v)} classNames={inputStyle} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="起始" variant="bordered" size="sm" value={item.startDate || ""} onValueChange={(v) => updateItem(i, "startDate", v)} classNames={inputStyle} />
                      <Input label="结束" variant="bordered" size="sm" value={item.endDate || ""} onValueChange={(v) => updateItem(i, "endDate", v)} classNames={inputStyle} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">实习描述</label>
                      <RichTextEditor content={item.description || ""} onChange={(v) => updateItem(i, "description", v)} placeholder="描述实习职责和成果..." />
                      <BulletControls item={item} onChange={(next) => { const arr = [...contentJson]; arr[i] = next; onChange(arr); }} />
                    </div>
                  </>
                )}

                {sectionType === "projects" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="项目名称" variant="bordered" size="sm" value={item.name || ""} onValueChange={(v) => updateItem(i, "name", v)} classNames={inputStyle} />
                      <Input label="角色" variant="bordered" size="sm" value={item.role || ""} onValueChange={(v) => updateItem(i, "role", v)} classNames={inputStyle} />
                    </div>
                    <Input label="项目链接" variant="bordered" size="sm" value={item.url || ""} onValueChange={(v) => updateItem(i, "url", v)} placeholder="https://..." classNames={inputStyle} />
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="起始" variant="bordered" size="sm" value={item.startDate || ""} onValueChange={(v) => updateItem(i, "startDate", v)} classNames={inputStyle} />
                      <Input label="结束" variant="bordered" size="sm" value={item.endDate || ""} onValueChange={(v) => updateItem(i, "endDate", v)} classNames={inputStyle} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">项目描述</label>
                      <RichTextEditor content={item.description || ""} onChange={(v) => updateItem(i, "description", v)} placeholder="描述项目亮点和你的贡献..." />
                      <BulletControls item={item} onChange={(next) => { const arr = [...contentJson]; arr[i] = next; onChange(arr); }} />
                    </div>
                  </>
                )}

                {sectionType === "skills" && (
                  <>
                    <Input
                      label="技能分类"
                      variant="bordered"
                      size="sm"
                      value={item.category || ""}
                      onValueChange={(v) => updateItem(i, "category", v)}
                      placeholder="如：编程语言、框架、工具"
                      classNames={inputStyle}
                    />
                    <Textarea
                      label="技能列表"
                      variant="bordered"
                      size="sm"
                      classNames={inputStyle}
                      value={(item.items || []).join(", ")}
                      onValueChange={(v) => updateItem(i, "items", v.split(",").map((s: string) => s.trim()).filter(Boolean))}
                      placeholder="Python, React, Docker（逗号分隔）"
                      minRows={2}
                    />
                    <Input
                      label="备注（可选）"
                      variant="bordered"
                      size="sm"
                      value={item.remark || ""}
                      onValueChange={(v) => updateItem(i, "remark", v)}
                      classNames={inputStyle}
                    />
                  </>
                )}

                {sectionType === "certificates" && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="证书名称" variant="bordered" size="sm" value={item.name || ""} onValueChange={(v) => updateItem(i, "name", v)} classNames={inputStyle} />
                      <Input label="等级/分数" variant="bordered" size="sm" value={item.scoreOrLevel || ""} onValueChange={(v) => updateItem(i, "scoreOrLevel", v)} classNames={inputStyle} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="颁发机构" variant="bordered" size="sm" value={item.issuer || ""} onValueChange={(v) => updateItem(i, "issuer", v)} classNames={inputStyle} />
                      <Input label="获得日期" variant="bordered" size="sm" value={item.date || ""} onValueChange={(v) => updateItem(i, "date", v)} classNames={inputStyle} />
                    </div>
                    <Input label="证书链接（可选）" variant="bordered" size="sm" value={item.url || ""} onValueChange={(v) => updateItem(i, "url", v)} placeholder="https://..." classNames={inputStyle} />
                  </>
                )}

                {sectionType === "awards" && (
                  <>
                    <Input label="奖项名称" variant="bordered" size="sm" value={item.awardName || ""} onValueChange={(v) => updateItem(i, "awardName", v)} classNames={inputStyle} />
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="颁发机构" variant="bordered" size="sm" value={item.issuer || ""} onValueChange={(v) => updateItem(i, "issuer", v)} classNames={inputStyle} />
                      <Input label="获奖日期" variant="bordered" size="sm" value={item.awardedAt || ""} onValueChange={(v) => updateItem(i, "awardedAt", v)} classNames={inputStyle} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">获奖描述</label>
                      <RichTextEditor content={item.description || ""} onChange={(v) => updateItem(i, "description", v)} placeholder="补充奖项背景与成果..." />
                      <BulletControls item={item} onChange={(next) => { const arr = [...contentJson]; arr[i] = next; onChange(arr); }} />
                    </div>
                  </>
                )}

                {sectionType === "personalExperiences" && (
                  <>
                    <Input
                      label="经历标题"
                      variant="bordered"
                      size="sm"
                      value={item.experienceTitle || ""}
                      onValueChange={(v) => updateItem(i, "experienceTitle", v)}
                      classNames={inputStyle}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="起始" variant="bordered" size="sm" value={item.startDate || ""} onValueChange={(v) => updateItem(i, "startDate", v)} classNames={inputStyle} />
                      <Input label="结束" variant="bordered" size="sm" value={item.endDate || ""} onValueChange={(v) => updateItem(i, "endDate", v)} classNames={inputStyle} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold tracking-[0.06em] text-[var(--foreground-muted)]">内容</label>
                      <RichTextEditor content={item.description || ""} onChange={(v) => updateItem(i, "description", v)} placeholder="输入个人经历内容..." />
                      <BulletControls item={item} onChange={(next) => { const arr = [...contentJson]; arr[i] = next; onChange(arr); }} />
                    </div>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
            </DraggableListItem>
          ))}
        </SortableContext>
      </DndContext>

      <Button
        size="sm"
        startContent={<Plus size={12} />}
        onPress={addItem}
        data-testid={`resume-item-add-${sectionType}`}
        className="bauhaus-button bauhaus-button-outline !w-full !justify-center !border-dashed !px-4 !py-3 !text-[11px]"
      >
        {addButtonLabel(sectionType)}
        <span className="ml-2 text-[10px] text-[var(--foreground-muted)]">({itemCount})</span>
      </Button>
    </div>
  );
}
