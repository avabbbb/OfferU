"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, Chip, Link, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Spinner } from "@nextui-org/react";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import {
  dataModeLabel,
  roleBenchmarkApi,
  type RoleBenchmarkDetail,
  type RoleBenchmarkDocument,
  type RoleBenchmarkSignal,
} from "@/lib/api";
import { bauhausModalContentClassName } from "@/lib/bauhaus";
import { safeClientErrorMessage } from "@/lib/safe-error";

const DIRECTION_LABELS: Record<string, string> = {
  highly_distinctive: "高度特殊",
  distinctive: "特别强调",
  common: "市场基本盘",
  missing_common: "目标 JD 弱化",
};

const IMPORTANCE_LABELS: Record<string, string> = {
  must_have: "Must Have",
  strong: "Strong",
  nice_to_have: "Nice to have",
  not_present: "未出现",
};

function capabilityLabel(signal: RoleBenchmarkSignal) {
  const raw = signal.target_evidence?.[0]?.raw_capability;
  if (raw) return raw;
  return signal.capability_id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatUpdatedAt(value?: string) {
  return value ? value.replace("T", " ").slice(0, 16) : "未知";
}

function statusLabel(status?: string) {
  if (status === "pending") return "等待执行";
  if (status === "running") return "正在分析";
  if (status === "completed") return "已完成";
  if (status === "failed") return "执行失败";
  if (status === "blocked") return "Provider 被阻塞";
  return status || "未开始";
}

function SignalEvidence({ signal, documents }: { signal: RoleBenchmarkSignal; documents: RoleBenchmarkDocument[] }) {
  const sourceByRef = useMemo(
    () => new Map(documents.map((document) => [document.source_ref, document])),
    [documents]
  );
  const gap = signal.evidence_gap;
  const marketEvidence = signal.market_evidence || [];

  return (
    <details className="bauhaus-panel-sm bg-white">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 p-4">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-black text-[var(--foreground)]">{capabilityLabel(signal)}</span>
          <Chip size="sm" variant="flat" className="border border-[var(--border)] bg-[var(--surface-muted)] font-bold text-[var(--foreground)]">
            {IMPORTANCE_LABELS[signal.target_importance] || signal.target_importance}
          </Chip>
        </span>
        <span className="flex items-center gap-3 text-xs font-black text-[var(--foreground-muted)]">
          <span>同类 {formatPercent(signal.market_frequency)}</span>
          <span>{DIRECTION_LABELS[signal.direction] || signal.direction}</span>
        </span>
      </summary>
      <div className="border-t border-[var(--border)] px-4 pb-4 pt-3">
        <div className="grid gap-2 sm:grid-cols-5">
          <Metric label="目标重要度" value={IMPORTANCE_LABELS[signal.target_importance] || signal.target_importance} />
          <Metric label="同类岗位" value={`${signal.comparator_count} / ${signal.comparator_total}`} />
          <Metric label="置信度" value={`${Math.round(signal.confidence * 100)}%`} />
          <Metric label="角色特殊度" value={`${gap?.role_distinctiveness ?? 0}/100`} />
          <Metric label="证据强度" value={`${gap?.evidence_strength ?? 0}/100`} />
        </div>

        {gap && (
          <div className="mt-3 border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="bauhaus-label text-[var(--foreground-muted)]">Career Evidence Gap</p>
              <Chip
                size="sm"
                variant="flat"
                className={
                  gap.status === "supported"
                    ? "border border-emerald-600 bg-emerald-50 font-bold text-emerald-900"
                    : "border border-amber-500 bg-amber-50 font-bold text-amber-950"
                }
              >
                {gap.status === "supported" ? "已有证据" : gap.status === "partial" ? "证据不完整" : "缺少证据"}
              </Chip>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs font-semibold text-[var(--foreground-soft)]">
              <span>缺口 {gap.evidence_gap}/100</span>
              <span>训练优先级 {gap.training_priority}/100</span>
            </div>
            {gap.matched_evidence?.length > 0 && (
              <div className="mt-3 space-y-2">
                {gap.matched_evidence.map((evidence) => (
                  <div key={evidence.profile_section_id} className="border-l-2 border-[var(--primary-blue)] pl-3">
                    <p className="text-xs font-black text-[var(--foreground)]">{evidence.title || evidence.section_type}</p>
                    <p className="mt-1 text-xs font-medium leading-relaxed text-[var(--foreground-soft)]">{evidence.excerpt}</p>
                  </div>
                ))}
              </div>
            )}
            {gap.status === "missing" && (
              <p className="mt-2 text-xs font-semibold text-[var(--primary-red)]">当前没有匹配到 active verified career evidence；这里不是对经历的推断。</p>
            )}
          </div>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <EvidenceList title="目标 JD 证据" items={signal.target_evidence || []} />
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">同类岗位来源</p>
            <div className="mt-2 space-y-2">
              {marketEvidence.slice(0, 5).map((item) => {
                const document = sourceByRef.get(item.source_ref);
                return (
                  <div key={item.source_ref} className="border-l-2 border-[var(--border-strong)] pl-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-black text-[var(--foreground)]">{item.company} · {item.title}</p>
                      {document?.url && (
                        <Link href={document.url} target="_blank" rel="noopener noreferrer" aria-label={`打开来源 ${item.source_ref}`} className="text-[var(--primary-blue)]">
                          <ExternalLink size={14} />
                        </Link>
                      )}
                    </div>
                    <p className="mt-1 text-xs font-medium leading-relaxed text-[var(--foreground-soft)]">{item.observation.evidence_text}</p>
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--foreground-muted)]">{item.source_ref}</p>
                  </div>
                );
              })}
              {marketEvidence.length > 5 && <p className="text-xs font-semibold text-[var(--foreground-muted)]">另有 {marketEvidence.length - 5} 个来源，完整列表保留在 benchmark snapshot。</p>}
              {marketEvidence.length === 0 && <p className="text-xs font-medium text-[var(--foreground-muted)]">没有可展示的同类证据。</p>}
            </div>
          </div>
        </div>
      </div>
    </details>
  );
}

function EvidenceList({ title, items }: { title: string; items: RoleBenchmarkSignal["target_evidence"] }) {
  return (
    <div>
      <p className="bauhaus-label text-[var(--foreground-muted)]">{title}</p>
      <div className="mt-2 space-y-2">
        {items.map((item) => (
          <div key={item.id} className="border-l-2 border-[var(--primary-red)] pl-3">
            <p className="text-xs font-black text-[var(--foreground)]">{item.raw_capability} · {item.source_section}</p>
            <p className="mt-1 text-xs font-medium leading-relaxed text-[var(--foreground-soft)]">{item.evidence_text}</p>
          </div>
        ))}
        {items.length === 0 && <p className="text-xs font-medium text-[var(--foreground-muted)]">没有保存的目标证据。</p>}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <p className="bauhaus-label text-[var(--foreground-muted)]">{label}</p>
      <p className="mt-1 text-sm font-black text-[var(--foreground)]">{value}</p>
    </div>
  );
}

function SignalGroup({ title, description, signals, documents }: { title: string; description: string; signals: RoleBenchmarkSignal[]; documents: RoleBenchmarkDocument[] }) {
  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="bauhaus-label text-[var(--foreground-muted)]">{title}</p>
          <p className="mt-1 text-xs font-medium text-[var(--foreground-muted)]">{description}</p>
        </div>
        <span className="text-xs font-black text-[var(--foreground-muted)]">{signals.length} 项</span>
      </div>
      <div className="mt-3 space-y-2">
        {signals.map((signal) => <SignalEvidence key={signal.capability_id} signal={signal} documents={documents} />)}
        {signals.length === 0 && <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-3 text-sm font-medium text-[var(--foreground-muted)]">当前样本没有形成这一类结论。</div>}
      </div>
    </section>
  );
}

export function RoleIntelligencePanel({ jobId }: { jobId: number }) {
  const router = useRouter();
  const [benchmark, setBenchmark] = useState<RoleBenchmarkDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [fixtureConfirmOpen, setFixtureConfirmOpen] = useState(false);
  const [error, setError] = useState("");
  const fixtureEnabled = process.env.NODE_ENV !== "production";

  const loadBenchmark = useCallback(async () => {
    if (!Number.isInteger(jobId) || jobId <= 0) return;
    setLoading(true);
    setError("");
    try {
      const result = await roleBenchmarkApi.forJob(jobId);
      setBenchmark(result.found === false || !result.run_id ? null : result);
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "岗位情报加载失败"));
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void loadBenchmark();
  }, [loadBenchmark]);

  useEffect(() => {
    // A freshly saved Job may render before the automation worker commits its
    // first RoleBenchmarkRun. Keep the page live during that hand-off instead
    // of leaving the user with a permanent "not started" empty state.
    if (benchmark && !["pending", "running"].includes(benchmark.status || "")) return;
    const timer = window.setTimeout(() => void loadBenchmark(), 1500);
    return () => window.clearTimeout(timer);
  }, [benchmark, loadBenchmark]);

  const buildFixture = async () => {
    setBuilding(true);
    setError("");
    try {
      await roleBenchmarkApi.build(jobId, { runtime_id: "fixture" });
      setFixtureConfirmOpen(false);
      await loadBenchmark();
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "fixture benchmark 创建失败"));
    } finally {
      setBuilding(false);
    }
  };

  const documents = benchmark?.documents || [];
  const signals = benchmark?.signals || [];
  const distinctive = signals.filter((signal) => signal.direction === "distinctive" || signal.direction === "highly_distinctive");
  const common = signals.filter((signal) => signal.direction === "common");
  const missing = signals.filter((signal) => signal.direction === "missing_common");
  const training = [...signals]
    .filter((signal) => signal.evidence_gap?.training_priority > 0)
    .sort((a, b) => (b.evidence_gap?.training_priority || 0) - (a.evidence_gap?.training_priority || 0))
    .slice(0, 5);
  const targetProfile = benchmark?.target_profile || documents.find((document) => document.document_kind === "target")?.role_profile || {};

  return (
    <Card id="role-intelligence-panel" className="bauhaus-panel rounded-none bg-white shadow-none" data-testid="role-intelligence-panel">
      <CardBody className="space-y-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">Role intelligence</p>
            <h2 className="mt-2 text-2xl font-black tracking-[-0.05em] text-[var(--foreground)]">岗位情报</h2>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              只展示由 OfferU Runtime 从 benchmark snapshot 统计出的岗位差异；市场百分比和准备缺口不由 LLM 生成。
            </p>
          </div>
          <Button isIconOnly aria-label="刷新岗位情报" variant="light" isLoading={loading} onPress={() => void loadBenchmark()} className="min-h-11 min-w-11 border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)]">
            <RefreshCw size={17} />
          </Button>
        </div>

        {error && <div className="bauhaus-panel-sm border-[var(--primary-red)] bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</div>}

        {loading && !benchmark ? (
          <div className="bauhaus-panel-sm flex items-center gap-3 bg-[var(--surface-muted)] px-4 py-4">
            <Spinner size="sm" color="warning" />
            <span className="text-sm font-semibold text-[var(--foreground-soft)]">正在读取岗位基准...</span>
          </div>
        ) : !benchmark ? (
          <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
            <p className="text-sm font-black text-[var(--foreground)]">还没有岗位基准</p>
            <p className="mt-1 text-sm font-medium leading-relaxed text-[var(--foreground-muted)]">真实外部采集仍受 provider 验收状态控制。当前开发环境可以加载去标识化 fixture，验证 Job Detail 的数据呈现和 evidence gap。</p>
            {fixtureEnabled && (
              <Button onPress={() => setFixtureConfirmOpen(true)} className="bauhaus-button bauhaus-button-yellow mt-4 !px-4 !py-3 !text-[11px]">加载 fixture benchmark</Button>
            )}
          </div>
        ) : benchmark.status !== "completed" ? (
          <div className={`bauhaus-panel-sm p-4 ${benchmark.status === "failed" || benchmark.status === "blocked" ? "border-[var(--primary-red)] bg-red-50" : "bg-[var(--surface-muted)]"}`}>
            <div className="flex items-start gap-3">
              {benchmark.status === "failed" || benchmark.status === "blocked" ? <AlertTriangle className="mt-0.5 shrink-0 text-[var(--primary-red)]" size={18} /> : <Spinner className="mt-0.5 shrink-0" size="sm" color="warning" />}
              <div>
                <p className="text-sm font-black text-[var(--foreground)]">{statusLabel(benchmark.status)}</p>
                <p className="mt-1 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">{benchmark.last_error || `运行 ${benchmark.run_id || ""} 尚未产出可展示的 benchmark snapshot。`}</p>
                {benchmark.error_id && <p className="mt-2 text-xs font-bold text-[var(--foreground-muted)]">错误 ID：{benchmark.error_id}</p>}
                {(benchmark.status === "failed" || benchmark.status === "blocked") && fixtureEnabled && <Button onPress={() => setFixtureConfirmOpen(true)} className="bauhaus-button bauhaus-button-yellow mt-4 !px-4 !py-3 !text-[11px]">用 fixture 验证 UI</Button>}
              </div>
            </div>
          </div>
        ) : (
          <>
            {benchmark.latest_attempt && benchmark.latest_attempt.status !== "completed" && (
              <div className="bauhaus-panel-sm flex items-start gap-3 border-amber-500 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950">
                <AlertTriangle className="mt-0.5 shrink-0" size={18} />
                <div>
                  <p>正在展示上一份可用岗位基准；最近一次刷新{benchmark.latest_attempt.provider_blocked ? "因 Provider 认证被阻塞" : "未完成"}。</p>
                  {benchmark.latest_attempt.last_error && <p className="mt-1 font-medium">{benchmark.latest_attempt.last_error}</p>}
                  {benchmark.latest_attempt.error_id && <p className="mt-1 text-xs font-bold">错误 ID：{benchmark.latest_attempt.error_id}</p>}
                </div>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-4">
              <Metric label="参考岗位" value={String(benchmark.valid_sample_count ?? 0)} />
              <Metric label="公司数" value={String(benchmark.company_count ?? 0)} />
              <Metric label="更新时间" value={formatUpdatedAt(benchmark.updated_at)} />
              <Metric label="数据模式" value={dataModeLabel(benchmark.data_mode)} />
            </div>

            {(benchmark.data_mode === "fixture" || benchmark.data_mode === "fixture_plugin") && <div className="bauhaus-panel-sm border-amber-500 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950">Fixture benchmark：仅用于本地产品验收，不代表实时市场数据。</div>}
            {!benchmark.sample_sufficient && <div className="bauhaus-panel-sm flex items-start gap-3 border-amber-500 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950"><AlertTriangle className="mt-0.5 shrink-0" size={18} />样本不足（{benchmark.valid_sample_count ?? 0} / {benchmark.minimum_sample_count ?? 15}），不生成正式市场频率结论。</div>}

            <div className="grid gap-3 md:grid-cols-3">
              <Metric label="Role Family" value={String(targetProfile.role_family || "unknown")} />
              <Metric label="Specialization" value={String(targetProfile.specialization || "unknown")} />
              <Metric label="Seniority" value={String(targetProfile.seniority || "unknown")} />
            </div>

            {benchmark.sample_sufficient && (
              <>
                <SignalGroup title="目标岗位特别强调" description="目标 JD 出现且在同类岗位中相对少见的能力。" signals={distinctive} documents={documents} />
                <SignalGroup title="同类岗位普遍要求" description="目标 JD 与市场同类岗位共同出现的能力基本盘。" signals={common} documents={documents} />
                <SignalGroup title="同行普遍要求但目标 JD 弱化" description="同类岗位频繁出现，但目标 JD 没有明确能力 observation。" signals={missing} documents={documents} />
              </>
            )}

            {training.length > 0 && (
              <section className="border-t border-[var(--border-strong)] pt-5">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 shrink-0 text-[var(--primary-blue)]" size={18} />
                  <div>
                    <p className="bauhaus-label text-[var(--foreground-muted)]">Preparation priority</p>
                    <h3 className="mt-1 text-xl font-black tracking-[-0.04em] text-[var(--foreground)]">你的准备缺口</h3>
                    <p className="mt-1 text-sm font-medium text-[var(--foreground-muted)]">岗位特殊度 × active career evidence gap；这里只读已有 ProfileSection，不自动修改 Profile。</p>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {training.map((signal) => (
                    <div key={signal.capability_id} className="bauhaus-panel-sm flex items-center justify-between gap-3 bg-[var(--surface-muted)] p-3">
                      <div>
                        <p className="text-sm font-black text-[var(--foreground)]">{capabilityLabel(signal)}</p>
                        <p className="mt-1 text-xs font-semibold text-[var(--foreground-muted)]">岗位特殊度 {signal.evidence_gap.role_distinctiveness} · 证据强度 {signal.evidence_gap.evidence_strength}</p>
                      </div>
                      <Chip size="sm" variant="flat" className="border border-[var(--primary-red)] bg-red-50 font-black text-[var(--primary-red)]">{signal.evidence_gap.training_priority}</Chip>
                    </div>
                  ))}
                </div>
                {benchmark.run_id && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
                    <p className="max-w-xl text-xs font-semibold leading-relaxed text-[var(--foreground-muted)]">
                      进入 Interviewer Mode：问题由这些 Delta 和你的 Evidence Gap 决定，模糊回答会继续追问；Coach 复盘只在本场结束后出现。
                    </p>
                    <Button
                      data-testid="role-intelligence-start-training"
                      onPress={() => router.push(`/interview/ai?job_id=${jobId}&benchmark_run_id=${encodeURIComponent(benchmark.run_id || "")}`)}
                      className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]"
                    >
                      开始专项训练
                    </Button>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </CardBody>

      <Modal isOpen={fixtureConfirmOpen} onClose={() => setFixtureConfirmOpen(false)} size="md">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-6 py-5 text-xl font-black tracking-[-0.06em]">加载开发 fixture</ModalHeader>
          <ModalBody className="px-6 py-6">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">这会通过现有 `build_role_benchmark` Operation 写入一份明确标记为 fixture 的本地 benchmark snapshot，不访问外部网页，也不会修改 Job、Profile 或 Interview。</p>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={() => setFixtureConfirmOpen(false)} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">取消</Button>
            <Button onPress={() => void buildFixture()} isLoading={building} className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]">确认加载</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  );
}
