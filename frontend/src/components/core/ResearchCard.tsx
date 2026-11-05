"use client";

import { useState } from "react";

import { type Doc, useTool } from "@/lib/core";

// 岗位调研卡片，三层渐进式披露：
// 1. 一屏：一句话结论、最大风险、关键观察，各板块只露一句摘要；
// 2. 点开板块：要点，每条带口径标签（官方 / 媒体 / 第三方估算 / 社区信号 / 推断 / 缺口）；
// 3. 点标签：这条要点引用的来源。
// 调研文档是 doc kind=research 的 Markdown，写法见 jd-research/reference/interview-research-bar.md。

type Point = { text: string; label?: string; refs: string[] };
type Section = { title: string; summary: Point; points: Point[] };
type Source = { id: string; text: string; url?: string };
export type Research = { verdict: Point; risk: Point; highlights: Point[]; sections: Section[]; sources: Record<string, Source> };

const LABELS: Record<string, { name: string; tone: string }> = {
  official: { name: "官方", tone: "text-emerald-700 bg-emerald-50" },
  media: { name: "媒体", tone: "text-sky-700 bg-sky-50" },
  third_party_estimate: { name: "第三方估算", tone: "text-amber-700 bg-amber-50" },
  community: { name: "社区信号", tone: "text-violet-700 bg-violet-50" },
  inference: { name: "推断", tone: "text-[var(--foreground-muted)] bg-[var(--border)]" },
  gap: { name: "缺口", tone: "text-red-700 bg-red-50" },
};
const TAG = /\s?\[(official|media|third_party_estimate|community|inference|gap)((?:\s+S\d+)+)?\]\s?$/;
const BULLET = /^[-\x2A•]\s+/;
const URL_RE = /https?:\/\/\S+/;

function toPoint(line: string): Point {
  const m = line.match(TAG);
  if (!m || m.index === undefined) return { text: line, refs: [] };
  return { text: line.slice(0, m.index).trim(), label: m[1], refs: m[2] ? m[2].trim().split(/\s+/) : [] };
}

const EMPTY: Point = { text: "", refs: [] };

export function parseResearch(markdown: string): Research {
  const out: Research = { verdict: EMPTY, risk: EMPTY, highlights: [], sections: [], sources: {} };
  let current: Section | null = null;
  let head = true;
  let inSources = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim();
      head = false;
      inSources = /^(来源|sources?)$/i.test(title);
      current = inSources ? null : { title, summary: EMPTY, points: [] };
      if (current) out.sections.push(current);
      continue;
    }
    const bullet = BULLET.test(line) ? line.replace(BULLET, "") : null;
    if (inSources) {
      const m = (bullet ?? line).match(/^\[?(S\d+)\]?[\s:：.、]+(.+)$/);
      if (m) {
        const url = m[2].match(URL_RE)?.[0];
        out.sources[m[1]] = { id: m[1], text: (url ? m[2].replace(url, "") : m[2]).replace(/[\s·|,，]+$/, "").trim(), url };
      }
      continue;
    }
    if (head) {
      if (line.startsWith(">")) out.risk = toPoint(line.replace(/^>\s?(风险[:：])?\s?/, ""));
      else if (bullet !== null) out.highlights.push(toPoint(bullet));
      else if (!out.verdict.text) out.verdict = toPoint(line);
      continue;
    }
    if (!current) continue;
    if (bullet !== null) current.points.push(toPoint(bullet));
    else if (!current.summary.text) current.summary = toPoint(line);
    else current.points.push(toPoint(line));
  }
  return out;
}

// 口径徽标：点开列出这条引用的来源。still=true 时只显示（放在 <summary> 里，点击留给折叠）。
function Tag({ point, sources, still = false }: { point: Point; sources: Record<string, Source>; still?: boolean }) {
  const [open, setOpen] = useState(false);
  const tag = point.label ? LABELS[point.label] : undefined;
  if (!tag) return null;
  const name = tag.name + (point.refs.length ? " · " + point.refs.length + " 个来源" : "");
  const cls = "ml-1.5 rounded px-1.5 py-0.5 align-middle text-[11.5px] font-normal " + tag.tone;
  if (still) return <span className={cls}>{name}</span>;
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)} title={point.refs.length ? "看来源" : undefined} className={cls}>{name}</button>
      {open && point.refs.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-3 text-[12px] font-normal text-[var(--foreground-muted)]">
          {point.refs.map((id) => {
            const source = sources[id];
            return (
              <li key={id}>
                {id}{" "}
                {source?.url
                  ? <a href={source.url} target="_blank" rel="noreferrer" className="underline">{source.text || source.url}</a>
                  : (source?.text || "来源缺失")}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function PointRow({ point, sources }: { point: Point; sources: Record<string, Source> }) {
  return (
    <li className="text-[13px] leading-relaxed text-[var(--foreground)]">
      {point.text}
      <Tag point={point} sources={sources} />
    </li>
  );
}

export function ResearchCard({ docId }: { docId: number }) {
  const { data } = useTool<{ record: Doc }>("get", { type: "doc", id: docId }, 30000);
  const doc = data?.record;
  if (!doc?.body) return null;
  const research = parseResearch(doc.body);
  return (
    <section className="rounded-lg border border-[var(--border)] px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">{doc.title || "岗位调研"}</h2>
        <span className="text-[12px] text-[var(--foreground-muted)]">{String(doc.updated_at || "").slice(0, 10)}</span>
      </div>
      {research.verdict.text && (
        <div className="mt-2 text-[15px] font-medium leading-relaxed text-[var(--foreground)]">
          {research.verdict.text}<Tag point={research.verdict} sources={research.sources} />
        </div>
      )}
      {research.risk.text && (
        <div className="mt-1 text-[13px] text-amber-700">风险：{research.risk.text}<Tag point={research.risk} sources={research.sources} /></div>
      )}
      {research.highlights.length > 0 && (
        <ul className="mt-2 space-y-1">{research.highlights.map((p, i) => <PointRow key={i} point={p} sources={research.sources} />)}</ul>
      )}
      {research.sections.length > 0 ? (
        <div className="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {research.sections.map((section, i) => (
            <details key={i} className="py-2">
              <summary className="cursor-pointer select-none text-[13.5px]">
                <span className="font-medium text-[var(--foreground)]">{section.title}</span>
                {section.summary.text && (
                  <span className="ml-2 text-[13px] text-[var(--foreground-muted)]">
                    {section.summary.text}<Tag point={section.summary} sources={research.sources} still />
                  </span>
                )}
              </summary>
              {section.points.length > 0 && (
                <ul className="mt-2 space-y-1.5 pl-4">{section.points.map((p, j) => <PointRow key={j} point={p} sources={research.sources} />)}</ul>
              )}
            </details>
          ))}
        </div>
      ) : !research.verdict.text && (
        <p className="mt-2 whitespace-pre-wrap text-[13px] text-[var(--foreground)]">{doc.body}</p>
      )}
    </section>
  );
}
