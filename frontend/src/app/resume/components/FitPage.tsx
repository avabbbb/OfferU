"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Scales a fixed-size page (A4/Letter at CSS mm) down to the width of its
 * container so the whole page is always visible, and reserves the scaled
 * height so nothing below is overlapped or clipped.
 */
export function FitPage({ children, maxScale = 1, padding = 24 }: { children: ReactNode; maxScale?: number; padding?: number }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.7);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const available = outer.clientWidth - padding * 2;
      const natural = inner.scrollWidth || 1;
      const next = Math.max(0.3, Math.min(maxScale, available / natural));
      setScale(next);
      setHeight(inner.scrollHeight * next + padding * 2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [maxScale, padding]);

  return (
    <div ref={outerRef} className="relative w-full overflow-hidden" style={{ height }}>
      <div
        ref={innerRef}
        className="absolute left-1/2 top-0 w-max origin-top"
        style={{ transform: `translateX(-50%) scale(${scale})`, marginTop: padding }}
      >
        {children}
      </div>
    </div>
  );
}
