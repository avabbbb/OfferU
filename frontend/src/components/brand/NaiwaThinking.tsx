import { useId, type CSSProperties } from "react";

/**
 * 奶蛙托腮思考的加载动画。底图是去掉瞳孔和嘴的 LOGO（/mascot/naiwa-think-base.webp），
 * 瞳孔、眼皮、嘴用 SVG 叠加并由 globals.css 的 .nw-* 关键帧驱动：
 * 眼珠往上看 → 眯眼琢磨 → 眨眼 → 换个方向想 → 回正；嘴跟着歪；整颗头轻轻晃。
 * index.html 的启动 splash 内联了同一份 SVG（静态 HTML 里用不了 React）。
 */
export function NaiwaThinking({ size = 72, bubble = true, className = "" }: { size?: number; bubble?: boolean; className?: string }) {
  const raw = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const left = `nw-eye-l-${raw}`;
  const right = `nw-eye-r-${raw}`;
  return (
    <span className={`naiwa-think ${className}`} style={{ "--naiwa-size": `${size}px` } as CSSProperties} aria-hidden="true">
      <svg className="naiwa-think__svg" viewBox="0 0 1024 1024">
        <defs>
          <clipPath id={left}><circle cx="222" cy="328" r="126" /></clipPath>
          <clipPath id={right}><circle cx="800" cy="386" r="126" /></clipPath>
        </defs>
        <g className="nw-head">
          <image href="/mascot/naiwa-think-base.webp" width="1024" height="1024" />
          <g clipPath={`url(#${left})`}>
            <circle className="nw-pupil" cx="222" cy="330" r="78" />
            <g className="nw-lid"><rect x="80" y="-80" width="290" height="268" /><line x1="80" y1="188" x2="370" y2="188" /></g>
          </g>
          <g clipPath={`url(#${right})`}>
            <circle className="nw-pupil" cx="800" cy="387" r="79" />
            <g className="nw-lid"><rect x="660" y="-22" width="290" height="268" /><line x1="660" y1="246" x2="950" y2="246" /></g>
          </g>
          <line className="nw-mouth" x1="380" y1="537" x2="610" y2="570" />
        </g>
      </svg>
      {bubble && <span className="naiwa-think__bubble"><i /><i /><i /></span>}
    </span>
  );
}
