"use client";

import Link from "next/link";

import { AddEvent, EventRow } from "@/components/core/EventList";
import { RecentChanges } from "@/components/core/RecentChanges";
import { ProgressBoard } from "@/components/today/ProgressBoard";
import { type Overview, useTool } from "@/lib/core";

const STAGE: Record<string, string> = {
  not_started: "还没开始", preparing: "准备材料", applying: "投递中", testing: "笔试 / 测评", interviewing: "面试中", offer: "谈 offer", done: "已上岸",
};
const BUCKETS = [["overdue", "逾期"], ["today", "今天"], ["week", "7 天内"], ["later", "以后"], ["undated", "没定时间"]] as const;

/** 今天：一个下一步、要做的事、最近改动。Agent 的改动每 5 秒出现一次。 */
export default function TodayPage() {
  const { data } = useTool<Overview>("overview", {}, 5000);
  if (!data) return null;
  const empty = BUCKETS.every(([key]) => !data.todos[key].length);
  return (
    <div className="mx-auto max-w-3xl space-y-10 px-6 py-10">
      <header>
        <p className="text-[13px] text-[var(--foreground-muted)]">{data.today} · {STAGE[data.stage] ?? data.stage}</p>
        <Link href={data.next_step.link} className="mt-2 block text-[24px] font-semibold tracking-tight text-[var(--foreground)] hover:underline">
          {data.next_step.title}
        </Link>
        <p className="mt-1 text-[13.5px] text-[var(--foreground-muted)]">{data.next_step.why}</p>
      </header>

      <ProgressBoard counts={data.jobs} />

      <section>
        <h2 className="text-[13px] font-medium text-[var(--foreground-muted)]">要做的事</h2>
        {empty && <p className="mt-2 text-[13.5px] text-[var(--foreground-muted)]">还没有。截止、笔试、面试都可以记在这里，也可以让 Agent 帮你记。</p>}
        {BUCKETS.map(([key, name]) => data.todos[key].length > 0 && (
          <div key={key} className="mt-3">
            <h3 className={`text-[12px] ${key === "overdue" ? "text-[var(--foreground)] font-medium" : "text-[var(--foreground-muted)]"}`}>{name}</h3>
            <ul className="divide-y divide-[var(--border)]">{data.todos[key].map((event) => <EventRow key={event.id} event={event} />)}</ul>
          </div>
        ))}
        <AddEvent />
      </section>

      <RecentChanges items={data.recent_changes} />
    </div>
  );
}
