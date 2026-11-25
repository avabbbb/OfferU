"use client";

import { motion } from "framer-motion";
import { FACTOR_LABEL, scoreColor, type FactorKey, type ScoreVector } from "../postureMath";
import { Disclosure } from "../../kit";

interface SessionSample {
  composite: number;
  scores: ScoreVector;
}

interface Props {
  composite: number | null;
  scores: ScoreVector | null;
  state: AppState;
  sessionElapsed: number;
  sessionSamples: SessionSample[];
}

export type AppState =
  | "idle"
  | "requestingCamera"
  | "loadingModel"
  | "calibrating"
  | "live"
  | "stopped";

export const STATE_LABEL: Record<AppState, string> = {
  idle: "待机",
  requestingCamera: "请求摄像头",
  loadingModel: "加载模型",
  calibrating: "校准中",
  live: "实时评估",
  stopped: "已停止",
};

export function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
}

const VERDICT = { green: "坐姿稳定", yellow: "稍微调整一下", red: "需要坐直" } as const;
const FACTORS: FactorKey[] = ["headDrop", "forwardLean", "shoulderTilt", "earTilt", "lateralLean"];

export default function ScorePanel({ composite, scores, state, sessionElapsed, sessionSamples }: Props) {
  const avg = sessionSamples.length
    ? Math.round(sessionSamples.reduce((s, x) => s + x.composite, 0) / sessionSamples.length)
    : null;
  const weakest = scores ? FACTORS.reduce((low, key) => (scores[key] < scores[low] ? key : low), FACTORS[0]) : null;

  return (
    <section className="iv-card" aria-label="姿态评估">
      <div className="flex items-baseline justify-between gap-3">
        <p className="iv-eyebrow">综合分 · 满分 100</p>
        <span className="iv-meta tabular-nums">{STATE_LABEL[state]} · {formatTime(sessionElapsed)}</span>
      </div>
      <motion.p
        key={composite ?? "—"}
        initial={{ opacity: 0.5, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        className="iv-score mt-2"
        data-empty={composite === null ? "" : undefined}
        aria-live="polite"
      >
        {composite ?? "--"}
      </motion.p>
      <p className="iv-muted mt-2">
        {composite === null ? "开始后这里实时显示分数。" : VERDICT[scoreColor(composite)]}
        {weakest && scores && scores[weakest] < 60 ? ` · 注意${FACTOR_LABEL[weakest]}` : ""}
        {avg !== null ? ` · 本组平均 ${avg}` : ""}
      </p>

      <div className="mt-5">
        <Disclosure title="五项分解" summary={scores ? FACTORS.map((k) => scores[k]).join(" · ") : undefined}>
          <div className="space-y-3 pt-1">
            {FACTORS.map((k) => {
              const v = scores?.[k] ?? null;
              return (
                <div key={k}>
                  <div className="mb-1.5 flex items-center justify-between text-[length:var(--ou-type-sm)]">
                    <span>{FACTOR_LABEL[k]}</span>
                    <span className="font-semibold tabular-nums text-[var(--ou-text-primary)]">{v ?? "—"}</span>
                  </div>
                  <div className="iv-bar" data-tone={v === null ? undefined : v >= 60 ? "green" : v >= 40 ? "yellow" : "red"}>
                    <i style={{ width: v === null ? "0%" : `${v}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Disclosure>
      </div>
    </section>
  );
}
