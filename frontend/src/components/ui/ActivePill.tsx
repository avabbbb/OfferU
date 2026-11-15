"use client";

// 共享选中胶囊（参考 Inspora · Rolando「Bleep App」侧栏）：一组导航 / 分段里只有一颗白胶囊，
// 点击切换时从旧项滑到新项（只平移、不拉伸），图标与文字留在原地、只变深。
// 用法：放在宿主（加 `.ou-pill-host`）的第一个子节点；宿主里带
// aria-current="page" / aria-selected="true" / aria-checked="true" 的那一项就是胶囊要去的地方。
// 胶囊自己盯着宿主：路由变化（点击、前进后退、⌘K）、键盘切换、尺寸变化都会跟上。
// 尺寸变化（窗口缩放、侧栏变宽）直接对齐、不播动画；减少动效时 --ou-motion-glide 为 0，切换也是瞬时。

import { useLayoutEffect, useRef } from "react";

const SELECTED = '[aria-current="page"], [aria-selected="true"], [aria-checked="true"]';
const WATCHED = ["aria-current", "aria-selected", "aria-checked"];

interface Box { x: number; y: number; w: number; h: number }

/** 元素相对宿主的盒子：用 offset* 量，不受入场动画的 transform 影响，也随宿主内滚动。 */
function boxIn(host: HTMLElement, el: HTMLElement): Box {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== host) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (parent && parent !== host && !host.contains(parent)) break;
    node = parent;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

export function ActivePill() {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement;
    if (!pill || !host) return;
    let last: Box | null = null;
    let hostSize = "";
    let frame = 0;

    const place = (animate: boolean) => {
      const target = host.querySelector<HTMLElement>(SELECTED);
      // 宿主被隐藏（窄屏侧栏 display:none）或没有选中项：胶囊淡出，下次出现时直接落位。
      if (!target || host.offsetWidth === 0) {
        pill.dataset.state = "hidden";
        last = null;
        return;
      }
      const next = boxIn(host, target);
      const instant = !animate || !last;
      // 跨几行就稍微慢一点（Bleep：相邻一行约 0.3s，跨两三行约 0.4s），上限 1.45 倍。
      const span = last ? Math.max(Math.abs(next.y - last.y) / Math.max(next.h, 1), Math.abs(next.x - last.x) / Math.max(next.w, 1)) : 0;
      pill.style.setProperty("--ou-pill-span", String(Math.min(1 + Math.max(span - 1, 0) * 0.15, 1.45)));
      if (instant) pill.dataset.instant = "";
      pill.style.setProperty("--ou-pill-x", next.x + "px");
      pill.style.setProperty("--ou-pill-y", next.y + "px");
      pill.style.setProperty("--ou-pill-w", next.w + "px");
      pill.style.setProperty("--ou-pill-h", next.h + "px");
      pill.style.setProperty("--ou-pill-r", getComputedStyle(target).borderRadius);
      if (instant) {
        void pill.offsetWidth; // 先把无动画的位置提交，再恢复过渡
        delete pill.dataset.instant;
      }
      pill.dataset.state = "shown";
      host.dataset.pillReady = "";
      last = next;
    };

    const schedule = (animate: boolean) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => place(animate));
    };

    place(false);

    const mutations = new MutationObserver(() => schedule(true));
    mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: WATCHED });

    // 只有宿主尺寸真的变了才重新对齐（瞬时），避免打断正在进行的滑动。
    const resize = new ResizeObserver(() => {
      const size = host.offsetWidth + "x" + host.offsetHeight;
      if (size === hostSize) return;
      hostSize = size;
      schedule(false);
    });
    resize.observe(host);
    document.fonts?.ready.then(() => schedule(false)).catch(() => undefined);

    return () => {
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resize.disconnect();
      delete host.dataset.pillReady;
    };
  }, []);

  return <span ref={ref} className="ou-active-pill" data-state="hidden" aria-hidden />;
}
