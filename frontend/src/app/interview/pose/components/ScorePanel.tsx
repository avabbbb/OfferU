"use client";

import { motion } from "framer-motion";
import { Button } from "@nextui-org/react";
import { FACTOR_LABEL, scoreColor, type FactorKey, type ScoreVector } from "../postureMath";

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
  onStart: () => void;
  onRecalibrate: () => void;
  onStop: () => void;
}

export type AppState =
  | "idle"
  | "requestingCamera"
  | "loadingModel"
  | "calibrating"
  | "live"
  | "stopped";

const STATE_LABEL: Record<AppState, string> = {
  idle: "待机",
  requestingCamera: "请求摄像头",
  loadingModel: "加载模型",
  calibrating: "校准中",
  live: "实时评估",
  stopped: "已停止",
};

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
}

function colorClass(score: number | null): string {
  if (score === null) return "text-[var(--foreground-muted)]";
  const c = scoreColor(score);
  if (c === "green") return "text-[var(--primary-green)]";
  if (c === "yellow") return "text-[var(--primary-yellow)]";
  return "text-[var(--primary-red)]";
}

export default function ScorePanel({
  composite,
  scores,
  state,
  sessionElapsed,
  sessionSamples,
  onStart,
  onRecalibrate,
  onStop,
}: Props) {
  const avg = sessionSamples.length
    ? Math.round(sessionSamples.reduce((s, x) => s + x.composite, 0) / sessionSamples.length)
    : null;
  const factors: FactorKey[] = ["headDrop", "forwardLean", "shoulderTilt", "earTilt", "lateralLean"];

  return (
    <div
      className="flex flex-col gap-6 rounded-xl border bg-[var(--surface)] p-6"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-[var(--foreground-soft)]">
          姿态评估
        </h2>
        <span className="text-xs text-[var(--foreground-muted)]">
          {STATE_LABEL[state]} · {formatTime(sessionElapsed)}
        </span>
      </div>

      <div className="text-center">
        <motion.div
          key={composite ?? "—"}
          initial={{ opacity: 0.4, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16 }}
          className={`text-7xl font-bold tracking-[-0.05em] ${colorClass(composite)}`}
        >
          {composite ?? "—"}
        </motion.div>
        <div className="mt-1 text-xs text-[var(--foreground-muted)]">综合分 / 满分 100</div>
        {avg !== null && (
          <div className="mt-2 text-xs text-[var(--foreground-soft)]">本会话平均 {avg}</div>
        )}
      </div>

      <div className="space-y-3">
        {factors.map((k) => {
          const v = scores?.[k] ?? null;
          return (
            <div key={k}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-[var(--foreground-soft)]">{FACTOR_LABEL[k]}</span>
                <span className={`font-semibold ${colorClass(v)}`}>{v ?? "—"}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: v === null ? "0%" : `${v}%`,
                    background:
                      v === null
                        ? "var(--foreground-faint)"
                        : v >= 60
                        ? "var(--primary-green)"
                        : v >= 40
                        ? "var(--primary-yellow)"
                        : "var(--primary-red)",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        {state === "idle" || state === "stopped" ? (
          <Button onPress={onStart} size="sm" className="flex-1" color="primary" variant="flat">
            开始
          </Button>
        ) : (
          <>
            <Button onPress={onRecalibrate} size="sm" variant="flat" className="flex-1">
              重新校准
            </Button>
            <Button onPress={onStop} size="sm" variant="flat" color="danger" className="flex-1">
              停止
            </Button>
          </>
        )}
      </div>
    </div>
  );
}