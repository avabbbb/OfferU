"use client";

// 输入框里的「/」浮层：就地搜索命令、快捷任务（以及之后的 Skill），焦点始终留在输入框。
// 键盘：↑/↓ 移动、Enter 或 Tab 选中、Esc 关闭（不清输入）；输入法组字期间不接管任何键。
// 触发与键盘规则移植自 avabbbb/Flovart@28c79bf（FlovartAgentPanel.tsx 的 / 触发 + hooks/useListboxKeyboard.ts）。

import { useMemo, useState, type ReactNode, type RefObject } from "react";
import { ListboxPopover, type ListboxOption } from "@/components/ui";
import { filterSlashCommands, removeSlashToken, slashTrigger, type SlashCommand, type SlashTrigger } from "@/lib/agentSlash";
import { isComposingEvent, moveListboxIndex, useListboxKeyboard } from "@/lib/useListboxKeyboard";

/** React 或原生的键盘事件都行（HeroUI Textarea 的 onKeyDown 两种都可能给）。 */
type SlashKeyEvent = Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "metaKey" | "ctrlKey" | "preventDefault" | "stopPropagation"> & { isComposing?: boolean; nativeEvent?: unknown; keyCode?: number };

export interface SlashAction extends SlashCommand {
  icon?: ReactNode;
  run: () => void;
}

export function useAgentSlash({ input, setInput, inputRef, commands }: {
  input: string;
  setInput: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  commands: SlashAction[];
}) {
  const [caret, setCaret] = useState(0);
  // Esc 之后同一个 "/" 不再弹出，直到删掉它或另起一个。
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const trigger: SlashTrigger | null = useMemo(() => slashTrigger(input, caret), [input, caret]);
  const open = Boolean(trigger) && trigger?.start !== dismissedAt;
  const matches = useMemo(() => (trigger ? filterSlashCommands(commands, trigger.query) : []), [commands, trigger]);

  const pick = (command: SlashAction) => {
    if (!trigger) return;
    const next = removeSlashToken(input, trigger, caret);
    setInput(next.text);
    setCaret(next.caret);
    window.requestAnimationFrame(() => {
      const element = inputRef.current;
      if (element && document.activeElement === element) element.setSelectionRange(next.caret, next.caret);
    });
    command.run();
  };

  const listbox = useListboxKeyboard<SlashAction>({
    items: matches,
    open,
    query: trigger?.query,
    autoFocus: false,
    onSelect: (command) => pick(command),
    onClose: () => setDismissedAt(trigger?.start ?? null),
  });

  /** 输入框的 onKeyDown 先交给这里；返回 true 表示已处理。 */
  const onKeyDown = (event: SlashKeyEvent): boolean => {
    if (!open || isComposingEvent(event)) return false;
    // 焦点在输入框（不是列表自己的搜索框），所以方向键 / Enter / Tab 在这里直接驱动高亮。
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !event.altKey && !event.metaKey && !event.ctrlKey) {
      if (!matches.length) return false;
      event.preventDefault();
      listbox.setActiveIndex(moveListboxIndex(listbox.activeIndex, matches.length, event.key === "ArrowDown" ? 1 : -1, { wrap: true }));
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && matches.length) {
      const index = listbox.activeIndex >= 0 ? listbox.activeIndex : 0;
      event.preventDefault();
      pick(matches[index]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(trigger?.start ?? null);
      return true;
    }
    return false;
  };

  /** 文本或光标变化时调用（onChange / onSelect / onKeyUp / onClick）。 */
  const syncCaret = () => {
    const element = inputRef.current;
    if (!element) return;
    setCaret(element.selectionStart ?? element.value.length);
    if (dismissedAt !== null && !slashTrigger(element.value, element.selectionStart ?? element.value.length)) setDismissedAt(null);
  };

  return { open, trigger, matches, listbox, pick, onKeyDown, syncCaret, close: () => setDismissedAt(trigger?.start ?? null) };
}

export function AgentSlashMenu({ slash, anchorRef }: {
  slash: ReturnType<typeof useAgentSlash>;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const options: ListboxOption[] = slash.matches.map((command) => ({
    id: command.id,
    label: command.label,
    description: command.description,
    group: command.group,
    hint: command.hint,
    icon: command.icon,
  }));
  return (
    <ListboxPopover
      open={slash.open}
      onOpenChange={(next) => { if (!next) slash.close(); }}
      anchorRef={anchorRef}
      options={options}
      listbox={slash.listbox}
      onPick={(_, index) => slash.pick(slash.matches[index])}
      label="命令和 Skill"
      empty="没有匹配的命令，继续输入会作为普通消息发送"
      testId="agent-slash-menu"
    />
  );
}
