"use client";

import { useEffect, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import { Button, Pill, type Tone } from "@/components/ui";
import { connectionsApi, type JobSourceConnection } from "@/lib/api";
import { SettingsGroup } from "./SettingsLayout";

const STATUS_LABEL: Record<JobSourceConnection["status"], string> = {
  READY: "已连接",
  EXPERIMENTAL: "实验性 · 已连接",
  AUTH_REQUIRED: "需要授权",
  DEGRADED: "部分可用",
  UNAVAILABLE: "不可用",
};

const STATUS_TONE: Record<JobSourceConnection["status"], Tone> = {
  READY: "green",
  EXPERIMENTAL: "green",
  AUTH_REQUIRED: "yellow",
  DEGRADED: "yellow",
  UNAVAILABLE: "red",
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
    <SettingsGroup
      label="岗位数据来源"
      testId="job-source-connections"
      note="OfferU 从这些来源感知求职世界。来源失败互不影响；BOSS 是实验性只读连接器。"
      action={
        <button type="button" className="ou-text-button" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} aria-hidden="true" /> {loading ? "读取中…" : "刷新"}
        </button>
      }
    >
      {loading && connections.length === 0 ? (
        <p className="ou-settings-item ou-settings-status" role="status">正在读取数据源状态…</p>
      ) : error ? (
        <p className="ou-settings-item ou-settings-error" role="alert">{error}</p>
      ) : connections.length === 0 ? (
        <p className="ou-settings-item ou-settings-status">暂无已注册的数据源。</p>
      ) : (
        connections.map((conn) => (
          <div key={conn.source_id} className="ou-settings-item">
            <span className="ou-tile" aria-hidden="true"><Plug size={16} /></span>
            <div className="ou-settings-item-text">
              <span className="ou-settings-item-label flex flex-wrap items-center gap-2">
                {conn.label}
                {conn.experimental && <Pill tone="gray">实验性</Pill>}
              </span>
              <span className="ou-settings-item-desc">
                {[conn.description, conn.capabilities.map((cap) => CAP_LABELS[cap] || cap).join(" · ")].filter(Boolean).join(" — ")}
              </span>
              {conn.last_sync && (
                <span className="ou-settings-hint">
                  上次同步 {new Date(conn.last_sync).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
            <div className="ou-settings-item-control">
              <Pill tone={STATUS_TONE[conn.status] || "gray"}>{STATUS_LABEL[conn.status] || conn.status}</Pill>
              {!conn.connected && conn.status === "AUTH_REQUIRED" && <Button size="sm">去授权</Button>}
            </div>
          </div>
        ))
      )}
    </SettingsGroup>
  );
}
