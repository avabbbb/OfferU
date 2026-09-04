"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Spinner } from "@nextui-org/react";
import { Camera, CameraOff, ShieldCheck } from "lucide-react";
import type { FaceLandmarkerResult, GestureRecognizerResult } from "@mediapipe/tasks-vision";
import SkeletonOverlay from "../../pose/components/SkeletonOverlay";
import {
  calibrationFromSamples,
  compositeScore,
  computeDeviation,
  extractFeatures,
  scoreColor,
  scoreDeviation,
  type Calibration,
  type FeatureVector,
  type Landmark,
  type ScoreVector,
} from "../../pose/postureMath";
import { LandmarkSmoother, ScalarSmoother } from "../../pose/smoothing";
import { createInterviewVisionEngine, type InterviewVisionEngine } from "../visionEngine";
import { GESTURE_LABEL, GESTURE_REACTION, type InterviewReaction } from "../reactionConfig";
import {
  ingestAIInterviewBehaviorEvents,
  type AIInterviewBehaviorEvent,
} from "@/lib/hooks";
import { safeClientErrorMessage } from "@/lib/safe-error";
import ReactionAvatar from "./ReactionAvatar";

type CameraState = "idle" | "requesting" | "loading" | "calibrating" | "live" | "error";

const CALIBRATION_FRAMES = 36;
const POSE_INTERVAL_MS = 90;
const DETAIL_INTERVAL_MS = 160;
const PERSON_LOST_MS = 1200;
const FACE_ALPHA = 0.3;
const EVENT_FLUSH_MS = 5000;
const DETECTOR_ID = "mediapipe-tasks-vision";
const DETECTOR_VERSION = "0.10.35";
const FACE_EVENT_TYPES = [
  "mouth_smile",
  "mouth_smile_jaw_open",
  "jaw_open_brow_raise",
  "mouth_pucker",
  "brow_down_mouth_frown",
] as const;
const GESTURE_EVENT_TYPE: Record<string, string> = {
  Victory: "gesture_victory",
  Thumb_Up: "gesture_thumb_up",
  Thumb_Down: "gesture_thumb_down",
  Open_Palm: "gesture_open_palm",
  Pointing_Up: "gesture_pointing_up",
  ILoveYou: "gesture_love",
  Closed_Fist: "gesture_closed_fist",
};

interface Props {
  interviewId: number;
  questionIndex: number;
  onBehaviorSummary?: (summary: Record<string, unknown>) => void;
}

interface ActiveBehaviorEvent {
  eventId: string;
  eventType: string;
  startedMs: number;
  confidenceTotal: number;
  samples: number;
  questionIndex: number;
}

function reactionFromScores(scores: ScoreVector, composite: number): InterviewReaction {
  if (scores.headDrop < 52 || scores.forwardLean < 52) return "straighten";
  if (scores.shoulderTilt < 48 || scores.earTilt < 48 || scores.lateralLean < 48) return "center";
  if (composite >= 78) return "focused";
  return "steady";
}

interface FaceSignals {
  smile: number;
  jawOpen: number;
  pucker: number;
  frown: number;
  browInnerUp: number;
  browDown: number;
}

const EMPTY_FACE_SIGNALS: FaceSignals = {
  smile: 0,
  jawOpen: 0,
  pucker: 0,
  frown: 0,
  browInnerUp: 0,
  browDown: 0,
};

function faceSignalsFromResult(result: FaceLandmarkerResult | null): FaceSignals {
  const categories = result?.faceBlendshapes?.[0]?.categories ?? [];
  const score = (name: string) => categories.find((item) => item.categoryName === name)?.score ?? 0;
  return {
    smile: (score("mouthSmileLeft") + score("mouthSmileRight")) / 2,
    jawOpen: score("jawOpen"),
    pucker: score("mouthPucker"),
    frown: (score("mouthFrownLeft") + score("mouthFrownRight")) / 2,
    browInnerUp: score("browInnerUp"),
    browDown: (score("browDownLeft") + score("browDownRight")) / 2,
  };
}

function smoothFaceSignals(previous: FaceSignals, current: FaceSignals): FaceSignals {
  const smooth = (signal: keyof FaceSignals) =>
    previous[signal] + FACE_ALPHA * (current[signal] - previous[signal]);
  return {
    smile: smooth("smile"),
    jawOpen: smooth("jawOpen"),
    pucker: smooth("pucker"),
    frown: smooth("frown"),
    browInnerUp: smooth("browInnerUp"),
    browDown: smooth("browDown"),
  };
}

function classifyFaceExpression(signals: FaceSignals): { reaction: InterviewReaction; label: string; score: number; eventType: string } | null {
  if (signals.smile >= 0.4 && signals.jawOpen >= 0.28) {
    return { reaction: "laughing", label: "嘴角上扬并张嘴", score: Math.max(signals.smile, signals.jawOpen), eventType: "mouth_smile_jaw_open" };
  }
  if (signals.jawOpen >= 0.5 && signals.browInnerUp >= 0.18) {
    return { reaction: "surprised", label: "张嘴并抬眉", score: Math.max(signals.jawOpen, signals.browInnerUp), eventType: "jaw_open_brow_raise" };
  }
  if (signals.pucker >= 0.45) {
    return { reaction: "pouting", label: "噘嘴动作", score: signals.pucker, eventType: "mouth_pucker" };
  }
  if (signals.frown >= 0.45 || signals.browDown >= 0.55) {
    return { reaction: "tense", label: "眉部下压或嘴角下沉", score: Math.max(signals.frown, signals.browDown), eventType: "brow_down_mouth_frown" };
  }
  if (signals.smile >= 0.36) {
    return { reaction: "smiling", label: "嘴角上扬", score: signals.smile, eventType: "mouth_smile" };
  }
  return null;
}

function bestGestureFromResult(result: GestureRecognizerResult | null) {
  const candidates = result?.gestures.flat() ?? [];
  return candidates.reduce<(typeof candidates)[number] | null>(
    (best, current) => (!best || current.score > best.score ? current : best),
    null
  );
}

export default function InterviewStage({ interviewId, questionIndex, onBehaviorSummary }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const engineRef = useRef<InterviewVisionEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const phaseRef = useRef<CameraState>("idle");
  const lastPoseInferenceRef = useRef(0);
  const lastDetailInferenceRef = useRef(0);
  const lastPoseVideoTimeRef = useRef(-1);
  const lastDetailVideoTimeRef = useRef(-1);
  const detailKindRef = useRef<"face" | "gesture">("face");
  const lastSeenRef = useRef(0);
  const calibrationRef = useRef<Calibration | null>(null);
  const calibrationSamplesRef = useRef<FeatureVector[]>([]);
  const landmarkSmootherRef = useRef(new LandmarkSmoother());
  const scoreSmootherRef = useRef(new ScalarSmoother<ScoreVector>());
  const postureReactionRef = useRef<InterviewReaction>("steady");
  const faceEmaRef = useRef<FaceSignals>({ ...EMPTY_FACE_SIGNALS });
  const faceHoldRef = useRef<{ reaction: InterviewReaction; until: number } | null>(null);
  const gestureCandidateRef = useRef({ name: "", count: 0 });
  const gestureHoldRef = useRef<{ reaction: InterviewReaction; until: number } | null>(null);
  const sessionStartedAtRef = useRef<number | null>(null);
  const questionIndexRef = useRef(questionIndex);
  const activeEventsRef = useRef<Record<string, ActiveBehaviorEvent>>({});
  const pendingEventsRef = useRef<AIInterviewBehaviorEvent[]>([]);
  const eventUploadRef = useRef(false);
  const lastEventFlushRef = useRef(0);

  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [error, setError] = useState("");
  const [landmarks, setLandmarks] = useState<Landmark[] | null>(null);
  const [reaction, setReaction] = useState<InterviewReaction>("ready");
  const [score, setScore] = useState<number | null>(null);
  const [faceSignal, setFaceSignal] = useState<string | null>(null);
  const [gestureSignal, setGestureSignal] = useState<string | null>(null);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [videoSize, setVideoSize] = useState({ width: 640, height: 480 });
  const [eventSyncError, setEventSyncError] = useState("");

  useEffect(() => {
    questionIndexRef.current = questionIndex;
  }, [questionIndex]);

  const flushBehaviorEvents = useCallback(async () => {
    if (eventUploadRef.current || pendingEventsRef.current.length === 0) return;
    eventUploadRef.current = true;
    lastEventFlushRef.current = performance.now();
    const batch = pendingEventsRef.current.splice(0, 200);
    try {
      const result = await ingestAIInterviewBehaviorEvents(interviewId, batch);
      onBehaviorSummary?.(result.summary);
      setEventSyncError("");
    } catch (cause) {
      pendingEventsRef.current = [...batch, ...pendingEventsRef.current];
      setEventSyncError(safeClientErrorMessage(cause, "派生事件同步失败"));
    } finally {
      eventUploadRef.current = false;
    }
  }, [interviewId, onBehaviorSummary]);

  const observeBehaviorEvent = useCallback((
    eventType: string,
    active: boolean,
    confidence: number,
    now: number
  ) => {
    const base = sessionStartedAtRef.current;
    if (base === null) return;
    const relativeNow = Math.max(0, Math.round(now - base));
    const current = activeEventsRef.current[eventType];
    if (active) {
      if (current) {
        current.confidenceTotal += Math.max(0, Math.min(1, confidence));
        current.samples += 1;
      } else {
        activeEventsRef.current[eventType] = {
          eventId: crypto.randomUUID(),
          eventType,
          startedMs: relativeNow,
          confidenceTotal: Math.max(0, Math.min(1, confidence)),
          samples: 1,
          questionIndex: questionIndexRef.current,
        };
      }
      return;
    }
    if (!current) return;
    delete activeEventsRef.current[eventType];
    pendingEventsRef.current.push({
      event_id: current.eventId,
      event_type: current.eventType,
      started_ms: current.startedMs,
      ended_ms: relativeNow,
      occurrence_count: 1,
      confidence: current.confidenceTotal / current.samples,
      detector_id: DETECTOR_ID,
      detector_version: DETECTOR_VERSION,
      metadata: { question_index: current.questionIndex },
    });
  }, []);

  const observeExclusiveEvents = useCallback((
    eventTypes: readonly string[],
    activeType: string | null,
    confidence: number,
    now: number
  ) => {
    eventTypes.forEach((eventType) => {
      observeBehaviorEvent(eventType, eventType === activeType, confidence, now);
    });
  }, [observeBehaviorEvent]);

  const finalizeBehaviorEvents = useCallback((now: number) => {
    Object.keys(activeEventsRef.current).forEach((eventType) => {
      observeBehaviorEvent(eventType, false, 0, now);
    });
  }, [observeBehaviorEvent]);

  const setPhase = useCallback((phase: CameraState) => {
    phaseRef.current = phase;
    setCameraState(phase);
  }, []);

  const resolveReaction = useCallback((now: number) => {
    const gesture = gestureHoldRef.current;
    if (gesture && gesture.until > now) return gesture.reaction;
    const face = faceHoldRef.current;
    if (face && face.until > now && face.reaction !== "smiling") return face.reaction;
    const posture = postureReactionRef.current;
    if (posture === "straighten" || posture === "center" || posture === "missing") return posture;
    if (face && face.until > now) return face.reaction;
    return posture;
  }, []);

  const releaseResources = useCallback(() => {
    finalizeBehaviorEvents(performance.now());
    void flushBehaviorEvents();
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    engineRef.current?.close();
    engineRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    landmarkSmootherRef.current.reset();
    scoreSmootherRef.current.reset();
    calibrationSamplesRef.current = [];
    calibrationRef.current = null;
    lastPoseVideoTimeRef.current = -1;
    lastDetailVideoTimeRef.current = -1;
    lastPoseInferenceRef.current = 0;
    lastDetailInferenceRef.current = 0;
    detailKindRef.current = "face";
    postureReactionRef.current = "steady";
    faceEmaRef.current = { ...EMPTY_FACE_SIGNALS };
    faceHoldRef.current = null;
    gestureCandidateRef.current = { name: "", count: 0 };
    gestureHoldRef.current = null;
    sessionStartedAtRef.current = null;
  }, [finalizeBehaviorEvents, flushBehaviorEvents]);

  const stopCamera = useCallback(() => {
    releaseResources();
    setPhase("idle");
    setLandmarks(null);
    setScore(null);
    setFaceSignal(null);
    setGestureSignal(null);
    setReaction("ready");
    setCalibrationProgress(0);
  }, [releaseResources, setPhase]);

  const runLoop = useCallback(() => {
    const tick = () => {
      const video = videoRef.current;
      const engine = engineRef.current;
      const now = performance.now();

      if (
        video &&
        engine &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.currentTime !== lastPoseVideoTimeRef.current &&
        now - lastPoseInferenceRef.current >= POSE_INTERVAL_MS
      ) {
        lastPoseInferenceRef.current = now;
        lastPoseVideoTimeRef.current = video.currentTime;
        const result = engine.detectPose(video, now);
        const detected = result?.landmarks?.[0] as Landmark[] | undefined;

        if (detected?.length) {
          observeBehaviorEvent("person_missing", false, 0, now);
          lastSeenRef.current = now;
          const smoothedLandmarks = landmarkSmootherRef.current.apply(detected);
          const features = extractFeatures(smoothedLandmarks);
          setLandmarks(smoothedLandmarks);

          if (phaseRef.current === "calibrating") {
            calibrationSamplesRef.current.push(features);
            const progress = Math.min(calibrationSamplesRef.current.length, CALIBRATION_FRAMES);
            setCalibrationProgress(progress);
            setReaction("calibrating");

            if (progress >= CALIBRATION_FRAMES) {
              calibrationRef.current = calibrationFromSamples(calibrationSamplesRef.current);
              scoreSmootherRef.current.reset();
              postureReactionRef.current = "steady";
              setPhase("live");
            }
          } else if (phaseRef.current === "live") {
            const deviation = computeDeviation(features, calibrationRef.current);
            const scores = scoreSmootherRef.current.apply(scoreDeviation(deviation));
            const composite = compositeScore(scores);
            postureReactionRef.current = reactionFromScores(scores, composite);
            observeBehaviorEvent("head_drop", scores.headDrop < 52, (52 - scores.headDrop) / 52, now);
            observeBehaviorEvent("forward_lean", scores.forwardLean < 52, (52 - scores.forwardLean) / 52, now);
            observeBehaviorEvent("shoulder_tilt", scores.shoulderTilt < 48, (48 - scores.shoulderTilt) / 48, now);
            observeBehaviorEvent("head_tilt", scores.earTilt < 48, (48 - scores.earTilt) / 48, now);
            observeBehaviorEvent("lateral_lean", scores.lateralLean < 48, (48 - scores.lateralLean) / 48, now);
            setScore(composite);
            setReaction(resolveReaction(now));
          }
        } else if (
          (phaseRef.current === "live" || phaseRef.current === "calibrating") &&
          now - lastSeenRef.current > PERSON_LOST_MS
        ) {
          observeBehaviorEvent("person_missing", true, 1, now);
          ["head_drop", "forward_lean", "shoulder_tilt", "head_tilt", "lateral_lean"].forEach((eventType) => {
            observeBehaviorEvent(eventType, false, 0, now);
          });
          postureReactionRef.current = "missing";
          setLandmarks(null);
          setScore(null);
          setFaceSignal(null);
          setGestureSignal(null);
          setReaction("missing");
        }
      }

      if (
        video &&
        engine &&
        phaseRef.current === "live" &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.currentTime !== lastDetailVideoTimeRef.current &&
        now - lastDetailInferenceRef.current >= DETAIL_INTERVAL_MS &&
        now - lastPoseInferenceRef.current >= 28
      ) {
        lastDetailInferenceRef.current = now;
        lastDetailVideoTimeRef.current = video.currentTime;

        if (detailKindRef.current === "face") {
          const currentSignals = faceSignalsFromResult(engine.detectFace(video, now));
          const smoothedSignals = smoothFaceSignals(faceEmaRef.current, currentSignals);
          faceEmaRef.current = smoothedSignals;
          const expression = classifyFaceExpression(smoothedSignals);
          if (expression) {
            faceHoldRef.current = { reaction: expression.reaction, until: now + 950 };
            setFaceSignal(`${expression.label} ${Math.round(expression.score * 100)}%`);
          }
          observeExclusiveEvents(
            FACE_EVENT_TYPES,
            expression?.eventType ?? null,
            expression?.score ?? 0,
            now
          );
          detailKindRef.current = "gesture";
        } else {
          const gesture = bestGestureFromResult(engine.detectGesture(video, now));
          const mapped = gesture ? GESTURE_REACTION[gesture.categoryName] : undefined;

          if (gesture && mapped) {
            const candidate = gestureCandidateRef.current;
            gestureCandidateRef.current = candidate.name === gesture.categoryName
              ? { name: candidate.name, count: candidate.count + 1 }
              : { name: gesture.categoryName, count: 1 };

            if (gestureCandidateRef.current.count >= 2) {
              gestureHoldRef.current = { reaction: mapped, until: now + 1100 };
              setGestureSignal(`${GESTURE_LABEL[gesture.categoryName] ?? gesture.categoryName} ${Math.round(gesture.score * 100)}%`);
              observeExclusiveEvents(
                Object.values(GESTURE_EVENT_TYPE),
                GESTURE_EVENT_TYPE[gesture.categoryName] ?? null,
                gesture.score,
                now
              );
            } else {
              observeExclusiveEvents(Object.values(GESTURE_EVENT_TYPE), null, 0, now);
            }
          } else {
            observeExclusiveEvents(Object.values(GESTURE_EVENT_TYPE), null, 0, now);
            gestureCandidateRef.current = { name: "", count: 0 };
            if (!gestureHoldRef.current || gestureHoldRef.current.until <= now) setGestureSignal(null);
          }
          detailKindRef.current = "face";
        }

        setReaction(resolveReaction(now));
      }

      if (gestureHoldRef.current && gestureHoldRef.current.until <= now) {
        gestureHoldRef.current = null;
        setGestureSignal(null);
      }
      if (faceHoldRef.current && faceHoldRef.current.until <= now) {
        faceHoldRef.current = null;
        setFaceSignal(null);
      }
      if (pendingEventsRef.current.length > 0 && now - lastEventFlushRef.current >= EVENT_FLUSH_MS) {
        void flushBehaviorEvents();
      }

      if (phaseRef.current === "calibrating" || phaseRef.current === "live") {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [flushBehaviorEvents, observeBehaviorEvent, observeExclusiveEvents, resolveReaction, setPhase]);

  const startCamera = useCallback(async () => {
    releaseResources();
    setError("");
    setReaction("calibrating");
    setFaceSignal(null);
    setGestureSignal(null);
    setCalibrationProgress(0);
    setPhase("requesting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("摄像头画布尚未准备好");
      video.srcObject = stream;
      await video.play();
      setVideoSize({ width: video.videoWidth || 640, height: video.videoHeight || 480 });
      sessionStartedAtRef.current = performance.now();
      activeEventsRef.current = {};
      lastEventFlushRef.current = performance.now();

      setPhase("loading");
      engineRef.current = await createInterviewVisionEngine();
      calibrationSamplesRef.current = [];
      calibrationRef.current = null;
      lastSeenRef.current = performance.now();
      lastPoseInferenceRef.current = 0;
      lastDetailInferenceRef.current = performance.now();
      setPhase("calibrating");
      runLoop();
    } catch (cause) {
      releaseResources();
      const message = safeClientErrorMessage(cause, "摄像头或视觉模型初始化失败");
      setError(message);
      setReaction("missing");
      setPhase("error");
    }
  }, [releaseResources, runLoop, setPhase]);

  useEffect(() => releaseResources, [releaseResources]);

  const busy = cameraState === "requesting" || cameraState === "loading";
  const color = score === null ? "green" : scoreColor(score);

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-white shadow-[0_14px_45px_var(--shadow-soft)]">
      <div className="grid lg:grid-cols-2">
        <div
          className="relative overflow-hidden bg-[#171715]"
          style={{ aspectRatio: `${videoSize.width} / ${videoSize.height}` }}
        >
          <div className="absolute inset-0" style={{ transform: "scaleX(-1)" }}>
            <video ref={videoRef} playsInline muted className="h-full w-full object-contain" />
            <SkeletonOverlay landmarks={landmarks} width={videoSize.width} height={videoSize.height} scoreColor={color} />
          </div>

          <div className="absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent p-4 text-white">
            <div>
              <span className="flex items-center gap-2 text-xs font-medium">
                <span className={`h-2 w-2 rounded-full ${cameraState === "live" ? "bg-emerald-400" : "bg-white/50"}`} />
                本地视觉分析
              </span>
              {cameraState === "live" && (faceSignal || gestureSignal) && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                  {faceSignal && <span className="rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm">{faceSignal}</span>}
                  {gestureSignal && <span className="rounded-full bg-black/40 px-2 py-1 backdrop-blur-sm">{gestureSignal}</span>}
                </div>
              )}
            </div>
            {(cameraState === "calibrating" || cameraState === "live") && <button onClick={stopCamera} className="rounded-full bg-black/35 p-2 transition hover:bg-black/55" aria-label="关闭摄像头"><CameraOff size={15} /></button>}
          </div>

          {(cameraState === "idle" || cameraState === "error" || busy) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55 px-8 text-center text-white">
              {busy ? (
                <>
                  <Spinner color="white" size="sm" />
                  <p className="mt-3 text-sm font-medium">{cameraState === "requesting" ? "正在请求摄像头权限" : "正在加载姿态、表情和手势模型"}</p>
                </>
              ) : (
                <>
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10"><Camera size={21} /></div>
                  <p className="mt-4 text-sm font-semibold">开启镜头，获得实时表达反馈</p>
                  <p className="mt-1 max-w-xs text-xs leading-relaxed text-white/60">只提取身体、面部和手部特征，不录制、不上传视频。</p>
                  {error && <p role="alert" className="mt-3 text-xs text-[#ffc5b5]">{error}</p>}
                  <Button onPress={startCamera} className="mt-5 bg-white font-semibold text-[var(--foreground)]" size="sm" startContent={<Camera size={15} />}>
                    {cameraState === "error" ? "重新开启" : "开启镜头"}
                  </Button>
                </>
              )}
            </div>
          )}

          {cameraState === "calibrating" && (
            <div className="absolute inset-x-4 bottom-4 rounded-xl bg-black/55 p-3 text-white backdrop-blur-sm">
              <div className="flex items-center justify-between text-xs">
                <span>保持自然坐姿，正在校准</span>
                <span>{Math.round((calibrationProgress / CALIBRATION_FRAMES) * 100)}%</span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/20">
                <div className="h-full rounded-full bg-white transition-[width]" style={{ width: `${(calibrationProgress / CALIBRATION_FRAMES) * 100}%` }} />
              </div>
            </div>
          )}
        </div>

        <ReactionAvatar reaction={reaction} score={score} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] bg-white px-4 py-3 text-[11px] text-[var(--foreground-muted)]">
        <span className="flex items-center gap-1.5"><ShieldCheck size={14} /> 摄像头画面始终留在本机，只同步派生事件</span>
        <span>{eventSyncError || "姿态校准 · 52 维面部动作 · 7 类可观察手势 · 连续状态平滑"}</span>
      </div>
    </section>
  );
}
