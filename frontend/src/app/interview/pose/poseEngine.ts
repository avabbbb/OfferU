// poseEngine.ts
// MediaPipe PoseLandmarker 封装：初始化 + detectForVideo 循环 + cleanup
// API 参考 docs/INTERVIEW_POSE_POC_PLAN.md §1.3

import { FilesetResolver, PoseLandmarker, type PoseLandmarkerResult } from "@mediapipe/tasks-vision";

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";

export interface PoseEngineHandle {
  landmarker: PoseLandmarker;
  detect: (video: HTMLVideoElement, tsMs: number) => PoseLandmarkerResult;
  close: () => void;
}

export async function createPoseEngine(): Promise<PoseEngineHandle> {
  const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
  const landmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  return {
    landmarker,
    detect: (video, ts) => {
      try {
        return landmarker.detectForVideo(video, ts);
      } catch {
        return { landmarks: [] } as unknown as PoseLandmarkerResult;
      }
    },
    close: () => {
      try {
        landmarker.close();
      } catch {}
    },
  };
}
