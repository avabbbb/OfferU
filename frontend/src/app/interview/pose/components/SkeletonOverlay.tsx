"use client";

import { useEffect, useRef } from "react";
import type { Landmark } from "../postureMath";
import { LM } from "../postureMath";

interface Props {
  landmarks: Landmark[] | null;
  width: number;
  height: number;
  scoreColor: "green" | "yellow" | "red";
}

const BONE_PAIRS: [number, number][] = [
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftEar],
  [LM.rightShoulder, LM.rightEar],
  [LM.leftShoulder, LM.leftHip],
  [LM.rightShoulder, LM.rightHip],
  [LM.leftHip, LM.rightHip],
  [LM.leftEar, LM.rightEar],
  [LM.nose, LM.leftEar],
  [LM.nose, LM.rightEar],
];

const COLORS = {
  green: "#2f6e4f",
  yellow: "#946200",
  red: "#b4451f",
};

export default function SkeletonOverlay({ landmarks, width, height, scoreColor }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== width * dpr) canvas.width = width * dpr;
    if (canvas.height !== height * dpr) canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    if (!landmarks || landmarks.length === 0) return;

    const color = COLORS[scoreColor];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;

    for (const [a, b] of BONE_PAIRS) {
      const pa = landmarks[a];
      const pb = landmarks[b];
      if (!pa || !pb) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x * width, pa.y * height);
      ctx.lineTo(pb.x * width, pb.y * height);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    for (const idx of [
      LM.nose,
      LM.leftEar,
      LM.rightEar,
      LM.leftShoulder,
      LM.rightShoulder,
      LM.leftHip,
      LM.rightHip,
    ]) {
      const p = landmarks[idx];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x * width, p.y * height, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [landmarks, width, height, scoreColor]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      aria-hidden="true"
    />
  );
}