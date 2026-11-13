import { useEffect, useState } from "react";

/** 还能往哪边滚：开头被卷走了（start）/ 后面还有（end）。差 1px 以内算到头，避免小数像素抖动。 */
export function scrollEdges(position: number, max: number): { start: boolean; end: boolean } {
  return { start: position > 1, end: position < max - 1 };
}

/**
 * 给滚动容器挂上 data-more-start / data-more-end，CSS 按它们画边缘渐隐：
 * 后面还有内容时尾部渐隐，滚到底渐隐消失。直接写 DOM 属性，滚动时不触发重渲染。
 * 用法：const ref = useScrollEdges("y"); <ul ref={ref} className="ou-scroll-fade-y">
 */
export function useScrollEdges<T extends HTMLElement>(axis: "x" | "y") {
  const [el, setEl] = useState<T | null>(null);
  useEffect(() => {
    if (!el) return;
    const update = () => {
      const edges = axis === "x"
        ? scrollEdges(el.scrollLeft, el.scrollWidth - el.clientWidth)
        : scrollEdges(el.scrollTop, el.scrollHeight - el.clientHeight);
      el.toggleAttribute("data-more-start", edges.start);
      el.toggleAttribute("data-more-end", edges.end);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // 尺寸变了（开关 Agent 栏、窗口缩放）或内容变了（搜索过滤、新卡片）都要重算。
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const mutate = new MutationObserver(update);
    mutate.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
      mutate.disconnect();
    };
  }, [el, axis]);
  return setEl;
}
