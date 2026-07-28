// postureMath.ts
// 5 因子姿态评分 — 纯函数。来源：PosturePal(权重) + posture-pilot(阈值) + imposture(scoreFromDeviation)
// 关键点索引见 docs/INTERVIEW_POSE_POC_PLAN.md §3.1 (BlazePose 33 点)

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export const LM = {
  nose: 0,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
} as const;

export type FactorKey =
  | "headDrop"
  | "forwardLean"
  | "shoulderTilt"
  | "earTilt"
  | "lateralLean";

// badThreshold（归一化比值单位）
export const BAD_THRESHOLD: Record<FactorKey, number> = {
  headDrop: 0.25,
  forwardLean: 0.3,
  shoulderTilt: 0.06,
  earTilt: 0.06,
  lateralLean: 0.15,
};

// PosturePal 权重
export const WEIGHTS: Record<FactorKey, number> = {
  headDrop: 0.35,
  forwardLean: 0.25,
  shoulderTilt: 0.15,
  earTilt: 0.15,
  lateralLean: 0.1,
};

export type FeatureVector = Record<FactorKey, number>;
export type ScoreVector = Record<FactorKey, number>;

export interface Calibration {
  headDrop: number;
  forwardLean: number;
  lateralLean: number;
}

function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function scoreFromDeviation(dev: number, badThreshold: number): number {
  const abs = Math.abs(dev);
  if (abs >= badThreshold) return 0;
  return Math.round(100 * (1 - abs / badThreshold));
}

export function extractFeatures(lm: Landmark[]): FeatureVector {
  const ls = lm[LM.leftShoulder];
  const rs = lm[LM.rightShoulder];
  const lh = lm[LM.leftHip];
  const rh = lm[LM.rightHip];
  const nose = lm[LM.nose];
  const le = lm[LM.leftEar];
  const re = lm[LM.rightEar];

  const shoulderMid = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
  const hipMid = { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
  const W = dist(ls, rs) || 1e-6;

  return {
    headDrop: (nose.y - shoulderMid.y) / W,
    forwardLean: (shoulderMid.y - hipMid.y) / W,
    shoulderTilt: Math.abs(ls.y - rs.y) / W,
    earTilt: le && re ? Math.abs(le.y - re.y) / W : 0,
    lateralLean: (nose.x - shoulderMid.x) / W,
  };
}

export function calibrationFromSamples(samples: FeatureVector[]): Calibration {
  if (samples.length === 0) {
    return { headDrop: 0, forwardLean: 0, lateralLean: 0 };
  }
  const avg = (key: "headDrop" | "forwardLean" | "lateralLean") =>
    samples.reduce((s, v) => s + v[key], 0) / samples.length;
  return {
    headDrop: avg("headDrop"),
    forwardLean: avg("forwardLean"),
    lateralLean: avg("lateralLean"),
  };
}

export function computeDeviation(
  cur: FeatureVector,
  calib: Calibration | null
): FeatureVector {
  if (!calib) {
    return {
      headDrop: cur.headDrop,
      forwardLean: cur.forwardLean,
      shoulderTilt: cur.shoulderTilt,
      earTilt: cur.earTilt,
      lateralLean: Math.abs(cur.lateralLean),
    };
  }
  return {
    headDrop: cur.headDrop - calib.headDrop,
    forwardLean: cur.forwardLean - calib.forwardLean,
    shoulderTilt: cur.shoulderTilt,
    earTilt: cur.earTilt,
    lateralLean: Math.abs(cur.lateralLean - calib.lateralLean),
  };
}

export function scoreDeviation(dev: FeatureVector): ScoreVector {
  return {
    headDrop: scoreFromDeviation(dev.headDrop, BAD_THRESHOLD.headDrop),
    forwardLean: scoreFromDeviation(dev.forwardLean, BAD_THRESHOLD.forwardLean),
    shoulderTilt: scoreFromDeviation(dev.shoulderTilt, BAD_THRESHOLD.shoulderTilt),
    earTilt: scoreFromDeviation(dev.earTilt, BAD_THRESHOLD.earTilt),
    lateralLean: scoreFromDeviation(dev.lateralLean, BAD_THRESHOLD.lateralLean),
  };
}

export function compositeScore(scores: ScoreVector): number {
  return Math.round(
    (WEIGHTS.headDrop * scores.headDrop +
      WEIGHTS.forwardLean * scores.forwardLean +
      WEIGHTS.shoulderTilt * scores.shoulderTilt +
      WEIGHTS.earTilt * scores.earTilt +
      WEIGHTS.lateralLean * scores.lateralLean)
  );
}

export function scoreColor(score: number): "green" | "yellow" | "red" {
  if (score >= 60) return "green";
  if (score >= 40) return "yellow";
  return "red";
}

export const FACTOR_LABEL: Record<FactorKey, string> = {
  headDrop: "头部下垂",
  forwardLean: "前倾塌肩",
  shoulderTilt: "肩线倾斜",
  earTilt: "头部侧倾",
  lateralLean: "侧向偏移",
};