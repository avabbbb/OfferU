"use client";

// 面试姿态 PoC — 浏览器本地 MediaPipe Pose 实时评分
// 路由：/interview/pose
// 详见 docs/INTERVIEW_POSE_POC_PLAN.md

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Camera, Play, Square } from "lucide-react";
import SkeletonOverlay from "./components/SkeletonOverlay";
import ScorePanel, { STATE_LABEL, formatTime, type AppState } from "./components/ScorePanel";
import { Disclosure, Reveal, SPRING } from "../kit";
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

  const running = state === "calibrating" || state === "live";
  const busy = state === "requestingCamera" || state === "loadingModel";

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="iv-page-wide">
      <header>
        <h1 className="iv-title">姿态训练</h1>
        <p className="iv-lede">坐好，校准 2 秒，然后练 1 分钟。画面只在本机分析。</p>
      </header>

      {error && (
        <div role="alert" className="iv-alert mt-6 flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="iv-pose mt-6">
        <div className="iv-stage" style={{ aspectRatio: `${videoSize.w} / ${videoSize.h}` }}>
          <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-contain" style={{ transform: "scaleX(-1)" }} />
          <SkeletonOverlay landmarks={landmarks} width={videoSize.w} height={videoSize.h} scoreColor={showScoreColor} />
          {(state === "idle" || state === "stopped" || busy) && (
            <div className="iv-stage-veil">
              {busy ? (
                <p className="text-[length:var(--ou-type-body)] font-medium">{state === "loadingModel" ? "正在加载姿态模型…" : "正在请求摄像头权限…"}</p>
              ) : (
                <>
                  <span className="iv-stage-icon"><Camera size={20} aria-hidden="true" /></span>
                  <p className="mt-4 text-[length:var(--ou-type-section)] font-semibold">{state === "stopped" ? "这一组练完了" : "准备好就开始"}</p>
                  <p className="iv-stage-soft mt-1 text-[length:var(--ou-type-sm)]">{state === "stopped" ? "看看右边的总结，或者再来一组。" : "点下方「开始」授权摄像头。"}</p>
                </>
              )}
            </div>
          )}
          {state === "calibrating" && (
            <div className="iv-stage-bar" role="status">
              <div className="flex items-center justify-between gap-2"><span>校准中，请保持坐姿</span><span className="tabular-nums">{Math.round((calibSamples.current.length / CALIBRATION_FRAMES) * 100)}%</span></div>
              <div className="iv-stage-meter"><i style={{ width: `${(calibSamples.current.length / CALIBRATION_FRAMES) * 100}%` }} /></div>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <ScorePanel composite={composite} scores={scores} state={state} sessionElapsed={elapsed} sessionSamples={sessionSamples} />
          {state === "stopped" && sessionSamples.length > 0 && (
            <Reveal>
              <section className="iv-card">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="iv-h3">本组总结</h2>
                  <span className="iv-muted">平均 <b className="text-[var(--ou-text-primary)]">{avg}</b></span>
                </div>
                <div className="mt-4"><SessionBar samples={sessionSamples} /></div>
              </section>
            </Reveal>
          )}
          <Disclosure title="关于这个训练">
            浏览器本地 MediaPipe Pose 实时评估坐姿，按低头、前倾、肩线、头部倾斜、侧倾 5 个因子加权评分，不上传任何画面。参考 PosturePal · posture-pilot · MediaPipe Tasks Vision；不含语音、眼神与时序稳定性。
          </Disclosure>
        </div>
      </div>

      <div className="iv-dock" data-full="">
        <p className="iv-dock-info"><b>{STATE_LABEL[state]}</b> · {formatTime(elapsed)} / 1:00</p>
        {running ? (
          <>
            <button type="button" onClick={recalibrate} className="iv-quiet">重新校准</button>
            <button type="button" onClick={stop} className="iv-primary"><Square size={14} aria-hidden="true" /> 停止</button>
          </>
        ) : (
          <button type="button" onClick={start} disabled={busy} className="iv-primary"><Play size={15} aria-hidden="true" /> {state === "stopped" ? "再来一组" : "开始"}</button>
        )}
      </div>
    </motion.div>
  );
}

function SessionBar({ samples }: { samples: SessionSample[] }) {
  const max = Math.ceil(samples.length / 12) || 1;
  const buckets: number[][] = Array.from({ length: max }, () => []);
  samples.forEach((s, i) => buckets[Math.floor(i / 12)].push(s.composite));
  const avgs = buckets.map((b) => Math.round(b.reduce((x, y) => x + y, 0) / b.length));
  return (
    <div className="iv-sparkbars" role="img" aria-label="每段平均分">
      {avgs.map((v, i) => (
        <i key={i} style={{ height: `${v}%` }} data-tone={v >= 60 ? undefined : v >= 40 ? "yellow" : "red"} title={`第 ${i + 1} 段：${v}`} />
      ))}
    </div>
  );
}
