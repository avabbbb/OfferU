"use client";

// 面试姿态 PoC — 浏览器本地 MediaPipe Pose 实时评分
// 路由：/interview/pose
// 详见 docs/INTERVIEW_POSE_POC_PLAN.md

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle } from "lucide-react";
import SkeletonOverlay from "./components/SkeletonOverlay";
import ScorePanel, { type AppState } from "./components/ScorePanel";
import {
  calibrationFromSamples,
  compositeScore,
  computeDeviation,
  extractFeatures,
  scoreDeviation,
  scoreColor,
  type Calibration,
  type Landmark,
  type ScoreVector,
  type FeatureVector,
} from "./postureMath";
import { LandmarkSmoother, ScalarSmoother } from "./smoothing";
import { createPoseEngine, type PoseEngineHandle } from "./poseEngine";
import { safeClientErrorMessage } from "@/lib/safe-error";

const CALIBRATION_FRAMES = 60; // ~2s @30fps
const SESSION_TARGET_SECONDS = 60;
const LOST_TIMEOUT_MS = 2000;

interface SessionSample {
  composite: number;
  scores: ScoreVector;
}

export default function PosePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<PoseEngineHandle | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lmSmoother = useRef(new LandmarkSmoother());
  const scoreSmoother = useRef(new ScalarSmoother<ScoreVector>());
  const calibSamples = useRef<FeatureVector[]>([]);
  const calibRef = useRef<Calibration | null>(null);
  const lastLandmarkTs = useRef<number>(0);
  const sessionStartRef = useRef<number>(0);
  const sessionSamplesRef = useRef<SessionSample[]>([]);

  const [state, setState] = useState<AppState>("idle");
  const [error, setError] = useState<string>("");
  const [landmarks, setLandmarks] = useState<Landmark[] | null>(null);
  const [composite, setComposite] = useState<number | null>(null);
  const [scores, setScores] = useState<ScoreVector | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [sessionSamples, setSessionSamples] = useState<SessionSample[]>([]);
  const [videoSize, setVideoSize] = useState({ w: 640, h: 480 });

  const showScoreColor = composite !== null ? scoreColor(composite) : "green";

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (engineRef.current) {
      engineRef.current.close();
      engineRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    lmSmoother.current.reset();
    scoreSmoother.current.reset();
    calibRef.current = null;
    calibSamples.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const loop = useCallback(() => {
    const video = videoRef.current;
    const engine = engineRef.current;
    if (!video || !engine) return;

    if (video.readyState >= 2 && video.videoWidth > 0) {
      if (videoSize.w !== video.videoWidth || videoSize.h !== video.videoHeight) {
        setVideoSize({ w: video.videoWidth, h: video.videoHeight });
      }
      const result = engine.detect(video, performance.now());
      const lm0 = result.landmarks?.[0];

      if (lm0 && lm0.length > 0) {
        lastLandmarkTs.current = performance.now();
        const smoothed = lmSmoother.current.apply(lm0 as Landmark[]);
        const features = extractFeatures(smoothed);
        const dev = computeDeviation(features, calibRef.current);
        const rawScores = scoreDeviation(dev);
        const sm = scoreSmoother.current.apply(rawScores);
        const comp = compositeScore(sm);

        setLandmarks(smoothed);
        setScores(sm);
        setComposite(comp);

        if (state === "calibrating") {
          calibSamples.current.push(features);
          if (calibSamples.current.length >= CALIBRATION_FRAMES) {
            calibRef.current = calibrationFromSamples(calibSamples.current);
            sessionStartRef.current = performance.now();
            sessionSamplesRef.current = [];
            setState("live");
          }
        } else if (state === "live") {
          sessionSamplesRef.current.push({ composite: comp, scores: sm });
          setElapsed((performance.now() - sessionStartRef.current) / 1000);
          if ((performance.now() - sessionStartRef.current) / 1000 >= SESSION_TARGET_SECONDS) {
            setSessionSamples([...sessionSamplesRef.current]);
            setState("stopped");
          }
        }
      } else if (state === "live" || state === "calibrating") {
        if (performance.now() - lastLandmarkTs.current > LOST_TIMEOUT_MS) {
          setLandmarks(null);
        }
      }
    }

    rafRef.current = requestAnimationFrame(loop);
  }, [state, videoSize]);

  useEffect(() => {
    if (state === "calibrating" || state === "live") {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(loop);
    }
    return () => {
      if (rafRef.current && (state === "idle" || state === "stopped")) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [state, loop]);

  const start = useCallback(async () => {
    setError("");
    setState("requestingCamera");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setState("loadingModel");
      const engine = await createPoseEngine();
      engineRef.current = engine;
      lmSmoother.current.reset();
      scoreSmoother.current.reset();
      calibSamples.current = [];
      lastLandmarkTs.current = performance.now();
      setState("calibrating");
    } catch (e: any) {
      setError(safeClientErrorMessage(e, "摄像头/模型初始化失败"));
      cleanup();
      setState("idle");
    }
  }, [cleanup]);

  const recalibrate = useCallback(() => {
    calibSamples.current = [];
    calibRef.current = null;
    lmSmoother.current.reset();
    scoreSmoother.current.reset();
    setLandmarks(null);
    setScores(null);
    setComposite(null);
    lastLandmarkTs.current = performance.now();
    setState("calibrating");
  }, []);

  const stop = useCallback(() => {
    if (sessionSamplesRef.current.length) {
      setSessionSamples([...sessionSamplesRef.current]);
    }
    setState("stopped");
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const avg = sessionSamples.length
    ? Math.round(sessionSamples.reduce((s, x) => s + x.composite, 0) / sessionSamples.length)
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="mx-auto max-w-5xl space-y-6 px-6 py-10"
    >
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[var(--foreground)]">
          面试姿态训练
        </h1>
        <p className="text-sm text-[var(--foreground-soft)]">
          浏览器本地实时评估坐姿，5 因子加权评分。所有处理在本机完成，不上传任何画面。
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border p-4 text-sm"
          style={{ borderColor: "var(--primary-red)", color: "var(--primary-red)", background: "var(--status-blush)" }}
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div
          className="relative overflow-hidden rounded-xl border bg-black"
          style={{ borderColor: "var(--border)", aspectRatio: `${videoSize.w} / ${videoSize.h}` }}
        >
          <video
            ref={videoRef}
            playsInline
            muted
            className="absolute inset-0 h-full w-full object-contain"
            style={{ transform: "scaleX(-1)" }}
          />
          <SkeletonOverlay
            landmarks={landmarks}
            width={videoSize.w}
            height={videoSize.h}
            scoreColor={showScoreColor}
          />
          {state === "idle" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-white/80">
              <p className="text-sm">点击右侧「开始」授权摄像头</p>
            </div>
          )}
          {state === "calibrating" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/40 text-center text-white">
              <p className="text-sm font-semibold">校准中…请保持坐姿</p>
              <p className="text-xs text-white/70">
                {calibSamples.current.length}/{CALIBRATION_FRAMES}
              </p>
            </div>
          )}
          {state === "loadingModel" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white text-sm">
              正在加载姿态模型…
            </div>
          )}
        </div>

        <ScorePanel
          composite={composite}
          scores={scores}
          state={state}
          sessionElapsed={elapsed}
          sessionSamples={sessionSamples}
          onStart={start}
          onRecalibrate={recalibrate}
          onStop={stop}
        />
      </div>

      {state === "stopped" && sessionSamples.length > 0 && (
        <div
          className="rounded-xl border p-6"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <div className="mb-4 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">本会话总结</h3>
            <span className="text-sm text-[var(--foreground-soft)]">平均分 {avg}</span>
          </div>
          <SessionBar samples={sessionSamples} />
        </div>
      )}

      <p className="text-xs text-[var(--foreground-muted)]">
        参考：PosturePal · posture-pilot · MediaPipe Tasks Vision · PoC 不含语音 / 眼神 / 时序稳定性
      </p>
    </motion.div>
  );
}

function SessionBar({ samples }: { samples: SessionSample[] }) {
  const max = Math.ceil(samples.length / 12) || 1;
  const buckets: number[][] = Array.from({ length: max }, () => []);
  samples.forEach((s, i) => buckets[Math.floor(i / 12)].push(s.composite));
  const avgs = buckets.map((b) => Math.round(b.reduce((x, y) => x + y, 0) / b.length));
  return (
    <div className="flex items-end gap-1.5" style={{ height: 80 }}>
      {avgs.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t"
          style={{
            height: `${v}%`,
            background: v >= 60 ? "var(--primary-green)" : v >= 40 ? "var(--primary-yellow)" : "var(--primary-red)",
          }}
          title={`第 ${i + 1} 段：${v}`}
        />
      ))}
    </div>
  );
}
