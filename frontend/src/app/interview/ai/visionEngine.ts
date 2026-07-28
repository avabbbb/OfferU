import {
  FaceLandmarker,
  FilesetResolver,
  GestureRecognizer,
  PoseLandmarker,
  type FaceLandmarkerResult,
  type GestureRecognizerResult,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const GESTURE_MODEL =
  "https://storage.googleapis.com/mediapipe-tasks/gesture_recognizer/gesture_recognizer.task";

export interface InterviewVisionEngine {
  detectPose: (video: HTMLVideoElement, timestamp: number) => PoseLandmarkerResult | null;
  detectFace: (video: HTMLVideoElement, timestamp: number) => FaceLandmarkerResult | null;
  detectGesture: (video: HTMLVideoElement, timestamp: number) => GestureRecognizerResult | null;
  close: () => void;
}

export async function createInterviewVisionEngine(): Promise<InterviewVisionEngine> {
  const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
  let pose: PoseLandmarker | null = null;
  let face: FaceLandmarker | null = null;
  let gesture: GestureRecognizer | null = null;

  try {
    pose = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    face = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: true,
    });

    gesture = await GestureRecognizer.createFromOptions(vision, {
      baseOptions: { modelAssetPath: GESTURE_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      cannedGesturesClassifierOptions: {
        maxResults: 1,
        scoreThreshold: 0.62,
        categoryDenylist: ["None"],
      },
    });
  } catch (error) {
    gesture?.close();
    face?.close();
    pose?.close();
    throw error;
  }

  if (!pose || !face || !gesture) throw new Error("视觉模型初始化不完整");

  const poseTask = pose;
  const faceTask = face;
  const gestureTask = gesture;

  return {
    detectPose: (video, timestamp) => {
      try {
        return poseTask.detectForVideo(video, timestamp);
      } catch {
        return null;
      }
    },
    detectFace: (video, timestamp) => {
      try {
        return faceTask.detectForVideo(video, timestamp);
      } catch {
        return null;
      }
    },
    detectGesture: (video, timestamp) => {
      try {
        return gestureTask.recognizeForVideo(video, timestamp);
      } catch {
        return null;
      }
    },
    close: () => {
      for (const task of [gestureTask, faceTask, poseTask]) {
        try {
          task.close();
        } catch {}
      }
    },
  };
}
