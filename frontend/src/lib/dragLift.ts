import type { DragEvent } from "react";

// 拖起来的样子（Event Swatch）：浏览器按 setDragImage 的元素截图，所以在屏幕外放一个已经倾斜 + 深阴影的副本给它截，
// 截完下一帧就删掉。原卡片在拖动期间带 data-dragging（变淡），松手时去掉。
export function liftDragImage(e: DragEvent<HTMLElement>) {
  const card = e.currentTarget;
  const rect = card.getBoundingClientRect();
  const holder = document.createElement("div");
  holder.className = "ou-drag-holder";
  const clone = card.cloneNode(true) as HTMLElement;
  clone.style.width = rect.width + "px";
  clone.style.height = rect.height + "px";
  clone.setAttribute("data-lifted", "");
  clone.removeAttribute("data-dragging");
  holder.appendChild(clone);
  document.body.appendChild(holder);
  const pad = parseFloat(getComputedStyle(holder).paddingLeft) || 0;
  e.dataTransfer.setDragImage(holder, e.clientX - rect.left + pad, e.clientY - rect.top + pad);
  window.setTimeout(() => holder.remove(), 0);
  // 原卡片下一帧再变淡，免得被截进拖动图里。
  window.requestAnimationFrame(() => card.setAttribute("data-dragging", ""));
  card.addEventListener("dragend", () => card.removeAttribute("data-dragging"), { once: true });
}
