// 「/」命令：在 Agent 输入框里打 / 就地搜索命令与 Skill，只用键盘完成（↑/↓、Enter / Tab 选中、Esc 关闭）。
// 触发规则与 Flovart 一致（avabbbb/Flovart@28c79bf:components/agent/FlovartAgentPanel.tsx 的 `(^|\s)/query$`
// 正则：只认光标前、行首或空白后的 /），纯函数在这里，面板只持有状态。

export interface SlashTrigger {
  /** "/" 在输入框里的下标。 */
  start: number;
  /** "/" 之后、光标之前的文字。 */
  query: string;
}

export interface SlashCommand {
  id: string;
  label: string;
  description?: string;
  group: string;
  /** 行尾提示，如 "/new"。 */
  hint?: string;
  keywords?: string[];
}

const TRIGGER = /(^|\s)\/([^\s/]{0,40})$/;

/** 光标前是否正在输入一个 "/命令"。 */
export function slashTrigger(text: string, caret: number = text.length): SlashTrigger | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = TRIGGER.exec(before);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

function score(command: SlashCommand, query: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const hint = (command.hint || "").replace(/^\//, "").toLowerCase();
  if (hint && hint.startsWith(q)) return 6;
  if (command.id.toLowerCase().startsWith(q)) return 5;
  const label = command.label.toLowerCase();
  if (label.startsWith(q)) return 4;
  if (label.includes(q)) return 3;
  if ((command.keywords || []).some((word) => word.toLowerCase().includes(q))) return 2;
  if ((command.description || "").toLowerCase().includes(q)) return 1;
  return 0;
}

/** 按匹配度过滤；同分保持原顺序（分组顺序不乱）。没有搜索词时原样返回。 */
export function filterSlashCommands<T extends SlashCommand>(commands: readonly T[], query: string): T[] {
  if (!query.trim()) return [...commands];
  return commands
    .map((command, index) => ({ command, index, score: score(command, query.trim()) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.command);
}

/** 选中后把 "/query" 从输入框里拿掉，返回新文本和光标位置。 */
export function removeSlashToken(text: string, trigger: SlashTrigger, caret: number = text.length): { text: string; caret: number } {
  const end = Math.max(trigger.start + 1 + trigger.query.length, Math.min(caret, text.length));
  const next = text.slice(0, trigger.start) + text.slice(end).replace(/^ /, "");
  return { text: next, caret: trigger.start };
}
