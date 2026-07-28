// smoothing.ts
// EMA 平滑 — 来源 posture-pilot：关键点 α=0.35 / 标量显示值 α=0.15

import type { Landmark } from "./postureMath";
import type { ScoreVector } from "./postureMath";

const LM_ALPHA = 0.35;
const SCORE_ALPHA = 0.15;

export class LandmarkSmoother {
  private prev: Landmark[] | null = null;

  apply(cur: Landmark[]): Landmark[] {
    if (!this.prev || this.prev.length !== cur.length) {
      this.prev = cur.map((p) => ({ ...p }));
      return this.prev;
    }
    const out = cur.map((p, i) => {
      const q = this.prev![i];
      return {
        x: q.x + LM_ALPHA * (p.x - q.x),
        y: q.y + LM_ALPHA * (p.y - q.y),
        z: q.z + LM_ALPHA * (p.z - q.z),
        visibility: p.visibility ?? q.visibility,
      };
    });
    this.prev = out;
    return out;
  }

  reset(): void {
    this.prev = null;
  }
}

export class ScalarSmoother<T extends Record<string, number>> {
  private prev: T | null = null;

  apply(cur: T): T {
    if (!this.prev) {
      this.prev = { ...cur };
      return this.prev;
    }
    const out: Record<string, number> = {};
    for (const k in cur) {
      const c = cur[k];
      const p = this.prev[k] ?? c;
      out[k] = p + SCORE_ALPHA * (c - p);
    }
    this.prev = out as T;
    return out as T;
  }

  reset(): void {
    this.prev = null;
  }
}

export type ScoreSmoother = ScalarSmoother<ScoreVector>;