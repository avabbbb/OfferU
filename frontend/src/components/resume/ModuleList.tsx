"use client";

// 「我的模块」：一组分组卡片行（Apple 设置式）。基础信息锁在第一位；其余模块拖把手排序、开关控制在简历里显不显示。
// 点模块名展开 / 收起这一块的编辑（renderBody，渐进式披露，一次只展开一块）；不给 renderBody 时只是切换选中。
// 下面「更多模块」是还没加过的常用模块，开关一开就加进来；最底下「添加自定义模块」。
// 只改 doc.resume.sections（顺序 / hidden / 增删），逻辑在 lib/resumeModules。
import {
  closestCenter, DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion } from "framer-motion";
import { Box, ChevronDown, GripVertical, Lock, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";

import { SPRING } from "@/app/interview/kit";

import { Menu, Switch } from "@/components/ui";
import type { Resume, ResumeSection } from "@/lib/resumeModel";
import { SECTION_LABEL } from "@/lib/resumeModel";
import { addCustomModule, addModule, morePresets, removeModule, reorderModules, setHidden } from "@/lib/resumeModules";

export const BASICS = "basics";

type Props = {
  resume: Resume;
  onChange: (next: Resume) => void;
  /** 右栏正在编辑的模块：BASICS 或 section.id。 */
  selected: string;
  onSelect: (id: string) => void;
  /** 给了就是手风琴：选中的那一块在行下面展开它的编辑区。 */
  renderBody?: (id: string) => ReactNode;
};

// 一行下面的展开区：高度 + 透明度一起动（减少动态效果时由外层 MotionConfig 变瞬时）。
function Body({ open, id, children }: { open: boolean; id: string; children: () => ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div key="body" id={id} className="rm-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }} transition={{ height: SPRING, opacity: { duration: 0.18 } }}>
          {children()}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const countLabel = (section: ResumeSection) => {
  const filled = section.items.filter((it) => it.title.trim() || it.text.trim() || it.bullets.some((b) => b.trim())).length;
  return filled ? filled + " 条" : "未填写";
};

function Row({ section, selected, onSelect, onToggle, onRename, onDelete, renderBody }: {
  section: ResumeSection; selected: boolean; onSelect: () => void; onToggle: (on: boolean) => void;
  onRename: (title: string) => void; onDelete: () => void; renderBody?: (id: string) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: section.id });
  const [editing, setEditing] = useState(false);
  const name = section.title.trim() || SECTION_LABEL[section.type];
  return (
    <li ref={setNodeRef} className="rm-group" data-open={(renderBody && selected) || undefined} data-dragging={isDragging || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}>
    <div className="rm-row" data-selected={selected || undefined} data-off={section.hidden || undefined} data-dragging={isDragging || undefined}>
      <button type="button" ref={setActivatorNodeRef} className="rm-grip" aria-label={"拖动排序：" + name} title="拖动排序（也可以聚焦后用方向键）"
        {...attributes} {...listeners}>
        <GripVertical size={14} aria-hidden />
      </button>
      {editing ? (
        <input autoFocus defaultValue={section.title} aria-label="模块名称" className="rm-input"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => { setEditing(false); const v = e.currentTarget.value.trim(); if (v && v !== section.title) onRename(v); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") { e.currentTarget.value = section.title; e.currentTarget.blur(); }
          }} />
      ) : (
        <>
          <button type="button" className="rm-name" aria-current={selected || undefined} title={name} onClick={onSelect}
            aria-expanded={renderBody ? selected : undefined} aria-controls={renderBody ? "rm-body-" + section.id : undefined}
            onDoubleClick={() => setEditing(true)}>
            {name}
          </button>
          {renderBody && (
            <span className="rm-meta" aria-hidden onClick={onSelect}>
              {section.hidden ? "已隐藏" : countLabel(section)}
              <ChevronDown size={15} className="rm-chevron" />
            </span>
          )}
        </>
      )}
      <Menu label={name + " 更多操作"} trigger={
        <button type="button" className="rm-more" aria-label={name + " 更多操作"} title="更多"><MoreHorizontal size={15} aria-hidden /></button>
      } items={[
        { label: "改名", icon: <Pencil size={15} />, onSelect: () => setEditing(true) },
        "separator",
        { label: "删除模块", description: "内容一起删掉；只想不显示就关掉开关", icon: <Trash2 size={15} />, danger: true, onSelect: onDelete },
      ]} />
      <Switch checked={!section.hidden} onCheckedChange={onToggle} aria-label={(section.hidden ? "在简历里显示" : "在简历里隐藏") + name} />
    </div>
    {renderBody && <Body open={selected} id={"rm-body-" + section.id}>{() => renderBody(section.id)}</Body>}
    </li>
  );
}

export function ModuleList({ resume, onChange, selected, onSelect, renderBody }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const more = morePresets(resume);
  const drop = ({ active, over }: DragEndEvent) => { if (over) onChange(reorderModules(resume, String(active.id), String(over.id))); };
  const add = (made: { resume: Resume; section: ResumeSection }) => { onChange(made.resume); onSelect(made.section.id); };
  const remove = (section: ResumeSection) => {
    const name = section.title.trim() || SECTION_LABEL[section.type];
    if (!window.confirm("删除「" + name + "」模块和里面的内容？（可以在「最近改动」里撤销）")) return;
    onChange(removeModule(resume, section.id));
    if (selected === section.id) onSelect(BASICS);
  };

  return (
    <nav className="rm" aria-label="简历模块" data-accordion={renderBody ? "" : undefined}>
      <h2 className="rm-heading">我的模块</h2>
      <ul className="rm-list">
        <li className="rm-group" data-open={(renderBody && selected === BASICS) || undefined}>
          <div className="rm-row" data-selected={selected === BASICS || undefined}>
            <span className="rm-grip rm-lock" title="基础信息固定在第一位"><Lock size={13} aria-hidden /></span>
            <button type="button" className="rm-name" aria-current={selected === BASICS || undefined} onClick={() => onSelect(BASICS)}
              aria-expanded={renderBody ? selected === BASICS : undefined} aria-controls={renderBody ? "rm-body-" + BASICS : undefined}>基础信息</button>
            {renderBody && (
              <span className="rm-meta" aria-hidden onClick={() => onSelect(BASICS)}>
                {resume.basics.name.trim() || "未填写"}<ChevronDown size={15} className="rm-chevron" />
              </span>
            )}
            <Switch checked disabled aria-label="基础信息总是显示" />
          </div>
          {renderBody && <Body open={selected === BASICS} id={"rm-body-" + BASICS}>{() => renderBody(BASICS)}</Body>}
        </li>
      </ul>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={drop}>
        <SortableContext items={resume.sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ul className="rm-list">
            {resume.sections.map((section) => (
              <Row key={section.id} section={section} selected={selected === section.id} onSelect={() => onSelect(section.id)}
                onToggle={(on) => onChange(setHidden(resume, section.id, !on))}
                onRename={(title) => onChange({ ...resume, sections: resume.sections.map((s) => (s.id === section.id ? { ...s, title } : s)) })}
                onDelete={() => remove(section)} renderBody={renderBody} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      {more.length > 0 && (
        <>
          <h2 className="rm-heading rm-heading-more">更多模块</h2>
          <ul className="rm-list rm-list-more">
            {more.map((preset) => (
              <li key={preset.key} className="rm-group">
                <div className="rm-row" data-off>
                  <span className="rm-grip rm-lock" aria-hidden><Box size={13} /></span>
                  <span className="rm-name rm-name-static" title={preset.title}>{preset.title}</span>
                  <Switch checked={false} onCheckedChange={() => add(addModule(resume, preset))} aria-label={"加入" + preset.title} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <button type="button" className="rm-add" onClick={() => add(addCustomModule(resume))}>
        <Plus size={15} aria-hidden />添加自定义模块
      </button>
    </nav>
  );
}
