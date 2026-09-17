"use client";

import { useEffect, useState } from "react";
import { Button, Chip, Spinner } from "@nextui-org/react";
import { Plug, RefreshCw } from "lucide-react";
import { connectionsApi, type JobSourceConnection } from "@/lib/api";

const STATUS_LABEL: Record<JobSourceConnection["status"], string> = {
  READY: "已连接",
  EXPERIMENTAL: "实验性 · 已连接",
  AUTH_REQUIRED: "需要授权",
  DEGRADED: "部分可用",
  UNAVAILABLE: "不可用",
};

const STATUS_COLOR: Record<JobSourceConnection["status"], "success" | "warning" | "danger" | "default" | "primary"> = {
  READY: "success",
  EXPERIMENTAL: "primary",
  AUTH_REQUIRED: "warning",
  DEGRADED: "warning",
  UNAVAILABLE: "danger",
};

const CAP_LABELS: Record<string, string> = {
  job_discovery: "岗位发现",
  job_details: "岗位详情",
  recommendations: "推荐",
  application_progress: "投递进展",
  inbox: "收件箱",
};

export function JobSourceConnectionsCard() {
  const [connections, setConnections] = useState<JobSourceConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await connectionsApi.list();
      setConnections(res.connections || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接状态加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="bauhaus-panel overflow-hidden bg-white" data-testid="job-source-connections">
      <div className="border-b border-[var(--border-strong)]/12 px-6 py-5 md:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">Connections</p>
            <h2 className="mt-1 text-xl font-black tracking-[-0.03em] text-[var(--foreground)]">
              岗位数据来源
            </h2>
            <p className="mt-1 max-w-xl text-sm font-medium text-[var(--foreground-soft)]">
              OfferU 从这些来源感知求职世界。来源失败不会互相影响；BOSS 是实验性只读连接器。
            </p>
          </div>
          <Button
            size="sm"
            variant="flat"
            onPress={() => void load()}
            isLoading={loading}
            className="bauhaus-button bauhaus-button-blue !px-3 !py-1.5 !text-[11px]"
            startContent={<RefreshCw size={13} />}
          >
            刷新
          </Button>
        </div>
      </div>

      <div className="divide-y divide-[var(--border)]">
        {loading && connections.length === 0 ? (
          <div className="flex items-center gap-3 px-6 py-6 md:px-8">
            <Spinner size="sm" color="warning" />
            <span className="text-sm font-medium text-[var(--foreground-soft)]">正在读取数据源状态…</span>
          </div>
        ) : error ? (
          <div className="px-6 py-6 md:px-8">
            <p className="text-sm font-semibold text-[var(--primary-red)]">{error}</p>
          </div>
        ) : connections.length === 0 ? (
          <div className="px-6 py-6 md:px-8">
            <p className="text-sm font-medium text-[var(--foreground-soft)]">暂无已注册的数据源。</p>
          </div>
        ) : (
          connections.map((conn) => (
            <div key={conn.source_id} className="flex flex-wrap items-center justify-between gap-4 px-6 py-5 md:px-8">
              <div className="flex items-center gap-4">
                <div className={`bauhaus-panel-sm flex h-11 w-11 items-center justify-center ${conn.connected ? "bg-[var(--primary-blue)] text-white" : "bg-[var(--surface-muted)] text-[var(--foreground-muted)]"}`}>
                  <Plug size={18} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-black text-[var(--foreground)]">{conn.label}</p>
                    {conn.experimental && (
                      <Chip size="sm" variant="flat" color="primary" className="!h-5 !text-[10px] font-bold">
                        Experimental
                      </Chip>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs font-medium text-[var(--foreground-muted)]">{conn.description}</p>
                  {conn.capabilities.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {conn.capabilities.map((cap) => (
                        <span key={cap} className="rounded-sm bg-[var(--surface-muted)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--foreground-soft)]">
                          {CAP_LABELS[cap] || cap}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="flex items-center gap-1.5">
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${conn.connected ? "bg-[var(--primary-blue)]" : "bg-[var(--border)]"}`} />
                    <span className="text-xs font-bold text-[var(--foreground)]">{STATUS_LABEL[conn.status] || conn.status}</span>
                  </div>
                  {conn.last_sync && (
                    <p className="mt-1 text-[10px] font-medium text-[var(--foreground-muted)]">
                      上次同步 {new Date(conn.last_sync).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  )}
                </div>
                {!conn.connected && conn.status === "AUTH_REQUIRED" && (
                  <Button size="sm" variant="flat" color="warning" className="!px-3 !py-1.5 !text-[11px] font-bold">
                    去授权
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
