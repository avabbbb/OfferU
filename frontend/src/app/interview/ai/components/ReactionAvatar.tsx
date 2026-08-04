"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import reactionAssets from "virtual:offeru-interview-reactions";
import type { InterviewReaction, ReactionAssetCatalog } from "../reactionConfig";

const COPY: Record<InterviewReaction, { eyebrow: string; title: string; detail: string }> = {
  ready: { eyebrow: "AI 面试官", title: "准备好后开启镜头", detail: "画面只在本机分析，不会上传。" },
  calibrating: { eyebrow: "正在校准", title: "保持自然坐姿", detail: "我正在建立你的个人姿态基线。" },
  focused: { eyebrow: "姿态观察", title: "上半身保持稳定", detail: "当前只记录可观察动作，不代表回答质量。" },
  steady: { eyebrow: "姿态观察", title: "继续自然作答", detail: "姿态统计与回答内容评分彼此独立。" },
  straighten: { eyebrow: "姿态提醒", title: "肩背打开一点", detail: "头部或上半身前倾，轻轻坐直即可。" },
  center: { eyebrow: "构图提醒", title: "回到画面中央", detail: "肩线或头部有些偏移，调整到镜头正中。" },
  missing: { eyebrow: "未识别到人物", title: "我暂时看不到你", detail: "检查光线，并让头部和双肩进入画面。" },
  smiling: { eyebrow: "面部动作", title: "识别到嘴角上扬", detail: "仅记录动作次数与时长，不判断情绪或面试表现。" },
  laughing: { eyebrow: "面部动作", title: "识别到嘴角上扬并张嘴", detail: "仅记录可观察动作，不进入内容评分。" },
  surprised: { eyebrow: "面部动作", title: "识别到张嘴并抬眉", detail: "动作本身不代表惊讶、压力或其他心理状态。" },
  pouting: { eyebrow: "面部动作", title: "识别到噘嘴动作", detail: "仅记录动作区间，不推断原因。" },
  tense: { eyebrow: "面部动作", title: "识别到眉部下压或嘴角下沉", detail: "动作本身不代表紧张或其他情绪。" },
  victory: { eyebrow: "识别到比耶", title: "收到你的胜利手势", detail: "手势识别稳定，右侧素材已同步切换。" },
  "thumbs-up": { eyebrow: "识别到点赞", title: "记录一次点赞手势", detail: "手势统计不代表自信、态度或回答质量。" },
  "thumbs-down": { eyebrow: "识别到拇指向下", title: "记录一次拇指向下手势", detail: "手势统计不推断赞同或反对。" },
  "open-palm": { eyebrow: "识别到张开手掌", title: "记录一次张开手掌", detail: "只保存派生事件，不保存手部画面。" },
  "pointing-up": { eyebrow: "识别到食指向上", title: "记录一次食指向上", detail: "只保存动作类型、区间与置信度。" },
  love: { eyebrow: "识别到 I Love You", title: "记录一次 I Love You 手势", detail: "动作统计不推断沟通意图。" },
  "closed-fist": { eyebrow: "识别到握拳", title: "记录一次握拳手势", detail: "只记录可观察动作，不推断心理状态。" },
};

const GESTURE_SYMBOL: Partial<Record<InterviewReaction, string>> = {
  victory: "✌",
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  "open-palm": "👋",
  "pointing-up": "☝",
  love: "🫶",
  "closed-fist": "✊",
};

interface Props {
  reaction: InterviewReaction;
  score: number | null;
}

export default function ReactionAvatar({ reaction, score }: Props) {
  const copy = COPY[reaction];
  const cursorRef = useRef<Partial<Record<InterviewReaction, number>>>({});
  const [candidates, setCandidates] = useState<string[]>([]);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [imageReady, setImageReady] = useState(false);
  const imageSrc = candidates[candidateIndex] ?? null;

  useEffect(() => {
    const catalog = reactionAssets as ReactionAssetCatalog;
    const assets = catalog[reaction] ?? [];
    const cursor = cursorRef.current[reaction] ?? 0;
    const start = assets.length ? cursor % assets.length : 0;
    cursorRef.current[reaction] = start + 1;
    setCandidates([...assets.slice(start), ...assets.slice(0, start)]);
    setCandidateIndex(0);
    setImageReady(false);
  }, [reaction]);

  return (
    <div className="relative flex h-full min-h-[320px] flex-col items-center justify-center overflow-hidden bg-[var(--surface-muted)] p-6 text-center">
      <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 py-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--foreground-muted)]">{copy.eyebrow}</span>
        {score !== null && <span className="rounded-full border border-[var(--border-strong)] bg-white px-2.5 py-1 text-[11px] font-semibold text-[var(--foreground-soft)]">姿态 {score}</span>}
      </div>

      <div className="relative flex h-56 w-full max-w-sm items-center justify-center">
        {!imageReady && <FallbackIllustration reaction={reaction} />}
        {imageSrc && (
          <motion.img
            key={imageSrc}
            src={imageSrc}
            alt={copy.title}
            className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-200 ${imageReady ? "opacity-100" : "opacity-0"}`}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: imageReady ? 1 : 0, scale: 1 }}
            onLoad={() => setImageReady(true)}
            onError={() => {
              setImageReady(false);
              setCandidateIndex((index) => index + 1);
            }}
          />
        )}
      </div>

      <motion.div key={`${reaction}-copy`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="relative -mt-1 max-w-sm">
        <p className="text-lg font-semibold tracking-[-0.03em] text-[var(--foreground)]">{copy.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--foreground-muted)]">{copy.detail}</p>
      </motion.div>
    </div>
  );
}

function FallbackIllustration({ reaction }: { reaction: InterviewReaction }) {
  const isHappy = reaction === "focused" || reaction === "smiling" || reaction === "laughing" || Boolean(GESTURE_SYMBOL[reaction]);
  const isConcerned = reaction === "straighten" || reaction === "center" || reaction === "pouting" || reaction === "tense";
  const isMissing = reaction === "missing";
  const symbol = GESTURE_SYMBOL[reaction];

  return (
    <motion.div key={reaction} className="relative h-52 w-60" initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: [0, -3, 0] }} transition={{ opacity: { duration: 0.2 }, scale: { duration: 0.24 }, y: { duration: 3.2, repeat: Infinity } }}>
      <svg viewBox="0 0 260 230" role="img" aria-label="内置缺图兜底插画" className="h-full w-full">
        <path d="M70 190C58 158 64 102 87 62C100 39 119 29 133 29C153 29 174 47 186 73C203 109 207 165 191 193C169 211 95 211 70 190Z" fill="#fffdf9" stroke="var(--foreground)" strokeWidth="3" strokeLinejoin="round" />
        <path d="M92 82C99 76 107 76 114 82M148 82C155 76 163 76 170 82" fill="none" stroke="var(--foreground)" strokeWidth="3" strokeLinecap="round" />
        <ellipse cx="103" cy="92" rx={isMissing ? 3 : 5} ry={isMissing ? 3 : 7} fill="var(--foreground)" />
        <ellipse cx="159" cy="92" rx={isMissing ? 3 : 5} ry={isMissing ? 3 : 7} fill="var(--foreground)" />
        <ellipse cx="84" cy="113" rx="13" ry="7" fill="#ead7ce" opacity="0.85" />
        <ellipse cx="178" cy="113" rx="13" ry="7" fill="#ead7ce" opacity="0.85" />
        {isHappy ? <path d="M112 117C122 132 143 132 152 117" fill="none" stroke="var(--foreground)" strokeWidth="3.5" strokeLinecap="round" /> : isConcerned ? <path d="M116 128C126 118 139 118 149 128" fill="none" stroke="var(--foreground)" strokeWidth="3.5" strokeLinecap="round" /> : <path d="M116 120C125 128 138 128 147 120" fill="none" stroke="var(--foreground)" strokeWidth="3.5" strokeLinecap="round" />}
        <path d="M99 190C98 178 102 169 110 164M164 190C165 178 161 169 153 164" fill="none" stroke="var(--foreground)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {symbol && <span className="absolute right-1 top-20 text-5xl drop-shadow-sm" aria-hidden="true">{symbol}</span>}
    </motion.div>
  );
}
