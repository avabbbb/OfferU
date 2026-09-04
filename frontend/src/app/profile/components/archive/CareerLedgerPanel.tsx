"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Brain,
  Check,
  Clock,
  FileWarning,
  History,
  Inbox,
  RotateCcw,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  type CareerLedgerEntry,
  type CareerModelEntry,
  type MemoryInboxItem,
  memoryApi,
} from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";

const TIER_LABELS: Record<string, string> = {
  verified_fact: "职业证据",
  preference: "求职偏好",
  career_hypothesis: "职业假设",
};

const STATUS_LABELS: Record<string, string> = {
  active: "有效",
  pending: "待处理",
  deferred: "稍后处理",
  applying: "写入中",
  accepted: "已接受",
  rejected: "已拒绝",
  revoked: "已撤销",
  invalidated: "来源失效",
  superseded: "已被取代",
};

const STATUS_TONES: Record<string, string> = {
  active: "bg-[var(--status-sage)] text-[var(--primary-green)]",
  pending: "bg-[var(--surface-muted)] text-[var(--foreground-muted)]",
  deferred: "bg-[var(--surface-muted)] text-[var(--foreground-muted)]",
  accepted: "bg-[var(--status-sage)] text-[var(--primary-green)]",
  revoked: "bg-[var(--status-blush)] text-[var(--primary-red)]",
  invalidated: "bg-[var(--status-blush)] text-[var(--primary-red)]",
  superseded: "bg-[var(--status-blush)] text-[var(--primary-red)]",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
        STATUS_TONES[status] || "bg-[var(--surface-muted)] text-[var(--foreground-muted)]"
      }`}
    >
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function entryPreview(entry: CareerModelEntry | MemoryInboxItem): string {
  const record = entry as CareerModelEntry & Partial<MemoryInboxItem>;
  const content = record.content_json || record.after || {};
  const bullet =
    typeof content.bullet === "string"
      ? content.bullet
      : typeof content.description === "string"
        ? content.description
        : "";
  return bullet || record.title || "";
}

interface LedgerSectionProps {
  icon: LucideIcon;
  label: string;
  count: number;
  children: React.ReactNode;
}

function LedgerSection(props: LedgerSectionProps) {
  const Icon = props.icon;
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-3.5 py-2.5">
        <Icon size={14} strokeWidth={1.75} className="text-[var(--foreground-muted)]" />
        <h3 className="text-[13px] font-semibold">{props.label}</h3>
        <span className="rounded bg-[var(--surface-muted)] px-1.5 py-0.5 text-[11px] text-[var(--foreground-muted)]">
          {props.count}
        </span>
      </header>
      <div className="divide-y divide-[var(--border)]">{props.children}</div>
    </section>
  );
}

export default function CareerLedgerPanel() {
  const [model, setModel] = useState<{
    entries: CareerModelEntry[];
    by_tier: Record<string, CareerModelEntry[]>;
    invalidated_entries: CareerModelEntry[];
  } | null>(null);
  const [inbox, setInbox] = useState<MemoryInboxItem[]>([]);
  const [ledger, setLedger] = useState<CareerLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const [modelData, inboxData, ledgerData] = await Promise.all([
        memoryApi.careerModel(),
        memoryApi.inbox({ status: "pending", limit: 50 }),
        memoryApi.ledger({ status: "all", limit: 100 }),
      ]);
      setModel(modelData);
      setInbox(inboxData.items);
      setLedger(ledgerData.entries);
      setError("");
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "加载职业模型失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const review = async (proposalId: number, action: string) => {
    setBusyId(proposalId);
    try {
      await memoryApi.reviewProposal(proposalId, action);
      await reload();
    } catch (err: any) {
      setError(safeClientErrorMessage(err, "审核失败"));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-[13px] text-[var(--foreground-muted)]">
        正在加载职业模型…
      </div>
    );
  }

  const activeCount = model?.entries.length ?? 0;
  const invalidCount = model?.invalidated_entries.length ?? 0;

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] leading-relaxed text-[var(--foreground-muted)]">
        职业模型由仍有效的档案条目派生；撤销、取代与来源失效的条目进入下方审计列表，不再参与岗位投影与材料生成。
      </p>

      {error && (
        <div className="rounded-md bg-[var(--status-blush)] px-3 py-2 text-[12.5px] font-medium text-[var(--primary-red)]">
          {error}
        </div>
      )}

      {/* 当前职业模型 */}
      <LedgerSection icon={Brain} label="当前职业模型" count={activeCount}>
        {activeCount === 0 ? (
          <EmptyRow text="暂无有效条目" />
        ) : (
          Object.entries(model?.by_tier || {})
            .sort(([a], [b]) => (a === "verified_fact" ? -1 : b === "verified_fact" ? 1 : a.localeCompare(b)))
            .map(([tier, entries]) => (
              <div key={tier}>
                <div className="bg-[var(--surface-muted)]/50 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
                  {TIER_LABELS[tier] || tier} · {entries.length}
                </div>
                {entries.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2 px-3.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium">{entry.title}</div>
                      <div className="truncate text-[12px] text-[var(--foreground-muted)]">
                        {entryPreview(entry)}
                      </div>
                      {entry.source_status !== "active" && (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--primary-red)]">
                          <FileWarning size={11} /> 来源已失效
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))
        )}
      </LedgerSection>

      {/* 失效条目审计 */}
      {invalidCount > 0 && (
        <LedgerSection icon={History} label="失效条目审计" count={invalidCount}>
          {model?.invalidated_entries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2 px-3.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium">{entry.title}</span>
                  <StatusBadge status={entry.status} />
                </div>
                <div className="mt-0.5 truncate text-[12px] text-[var(--foreground-muted)]">
                  {entry.superseded_by_id
                    ? `被条目 #${entry.superseded_by_id} 取代`
                    : entry.invalidated_at
                      ? `失效于 ${entry.invalidated_at.slice(0, 10)}`
                      : ""}
                </div>
              </div>
            </div>
          ))}
        </LedgerSection>
      )}

      {/* 待审核提案 */}
      <LedgerSection icon={Inbox} label="记忆收件箱 · 待审核" count={inbox.length}>
        {inbox.length === 0 ? (
          <EmptyRow text="没有待审核提案" />
        ) : (
          inbox.map((item) => (
            <div key={item.id} className="px-3.5 py-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                  {item.title}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    item.target_tier === "preference"
                      ? "bg-[var(--status-sage)] text-[var(--primary-green)]"
                      : "bg-[var(--surface-muted)] text-[var(--foreground-muted)]"
                  }`}
                >
                  {TIER_LABELS[item.target_tier] || item.target_tier}
                </span>
              </div>
              <div className="mt-1 text-[12px] leading-relaxed text-[var(--foreground-muted)]">
                {item.reason}
              </div>
              {item.supersedes_proposal_id && (
                <div className="mt-1 text-[11px] text-[var(--primary-red)]">
                  将取代提案 #{item.supersedes_proposal_id}
                </div>
              )}
              <div className="mt-2 flex items-center gap-1.5">
                <ReviewButton
                  label="接受"
                  icon={Check}
                  tone="sage"
                  busy={busyId === item.id}
                  onClick={() => review(item.id, "accept")}
                />
                <ReviewButton
                  label="拒绝"
                  icon={X}
                  tone="blush"
                  busy={busyId === item.id}
                  onClick={() => review(item.id, "reject")}
                />
                <ReviewButton
                  label="稍后"
                  icon={Clock}
                  tone="muted"
                  busy={busyId === item.id}
                  onClick={() => review(item.id, "defer")}
                />
              </div>
            </div>
          ))
        )}
      </LedgerSection>

      {/* 变更账本 */}
      <LedgerSection icon={History} label="职业模型变更账本" count={ledger.length}>
        {ledger.length === 0 ? (
          <EmptyRow text="账本为空" />
        ) : (
          ledger.map((item) => (
            <div key={item.id} className="px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                  #{item.id} {item.title}
                </span>
                <StatusBadge status={item.status} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--foreground-muted)]">
                <span>
                  {item.target_tier
                    ? TIER_LABELS[item.target_tier] || item.target_tier
                    : item.section_type}
                </span>
                {item.supersedes_proposal_id && <span>取代提案 #{item.supersedes_proposal_id}</span>}
                {item.applied_section?.superseded_by_id && (
                  <span>落地条目已被 #{(item.applied_section as any).superseded_by_id} 取代</span>
                )}
                <span>{item.created_at.slice(0, 10)}</span>
              </div>
              {item.status === "accepted" && item.applied_section?.status === "active" && (
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() => review(item.id, "revoke")}
                  className="mt-1.5 inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--primary-red)] transition-colors hover:bg-[var(--status-blush)] disabled:opacity-50"
                >
                  <RotateCcw size={11} strokeWidth={1.75} /> 撤销该条目
                </button>
              )}
            </div>
          ))
        )}
      </LedgerSection>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="px-3.5 py-4 text-center text-[12.5px] text-[var(--foreground-muted)]">
      {text}
    </div>
  );
}

function ReviewButton(props: {
  label: string;
  icon: LucideIcon;
  tone: "sage" | "blush" | "muted";
  busy: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  const toneClass =
    props.tone === "sage"
      ? "text-[var(--primary-green)] hover:bg-[var(--status-sage)]"
      : props.tone === "blush"
        ? "text-[var(--primary-red)] hover:bg-[var(--status-blush)]"
        : "text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)]";
  return (
    <button
      type="button"
      disabled={props.busy}
      onClick={props.onClick}
      className={`inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ${toneClass}`}
    >
      <Icon size={11} strokeWidth={1.75} />
      {props.label}
    </button>
  );
}
