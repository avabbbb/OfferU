/**
 * 分叉 / 引用的纯函数。
 *
 * 界面上的消息列表比服务端保存的对话多两类「只在本地」的消息：欢迎语（id 以 `welcome` 开头）
 * 和本地提示（如取消 Run 后的 `assistant-abort-*`、Run 中断 / 失败时保留的半截回答 `assistant-partial-*`）。分叉要把界面下标换算成服务端的消息条数，
 * 所以这两类都要跳过；它们也不显示分叉按钮。
 */

export interface BranchableMessage {
  id: string;
  role?: string;
  content?: string;
}

/** 只存在于本地、不会写进对话记录的提示消息的 id 前缀。 */
export const LOCAL_NOTICE_PREFIXES = ["assistant-abort-", "assistant-partial-"] as const;

export function isWelcomeMessage(message: Pick<BranchableMessage, "id">): boolean {
  return String(message.id || "").startsWith("welcome");
}

export function isLocalNoticeMessage(message: Pick<BranchableMessage, "id">): boolean {
  const id = String(message.id || "");
  return LOCAL_NOTICE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** 这条消息能不能作为分叉点：已保存的（非欢迎语、非本地提示）、有内容的消息。 */
export function canBranchFrom(message: BranchableMessage): boolean {
  return !isWelcomeMessage(message) && !isLocalNoticeMessage(message) && Boolean(String(message.content ?? "").trim());
}

/**
 * 分叉到 id 这条（含）为止，服务端要复制的消息条数。欢迎语、本地提示不算。
 * 找不到 id 时返回 0（调用方不应发请求）。
 */
export function branchUpto(messages: readonly BranchableMessage[], id: string): number {
  let count = 0;
  for (const message of messages) {
    const persisted = !isWelcomeMessage(message) && !isLocalNoticeMessage(message);
    if (persisted) count += 1;
    if (message.id === id) return persisted ? count : 0;
  }
  return 0;
}

/** 当前选区若完全落在 el 里，返回选中的文字（去首尾空白）；否则空串。 */
export function selectionWithin(el: Element | null | undefined): string {
  if (!el || typeof window === "undefined" || typeof window.getSelection !== "function") return "";
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return "";
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode || !el.contains(anchorNode) || !el.contains(focusNode)) return "";
  return selection.toString().trim();
}
