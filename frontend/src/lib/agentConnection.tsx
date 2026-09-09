"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { agentRuntimeApi, type AgentConnectionsSnapshot } from "./api";
import { safeClientErrorMessage } from "./safe-error";
import { SHOWCASE } from "./showcase/router";
import { useWorkbench } from "./workbench";

export interface ContextSyncState {
  status: "idle" | "syncing" | "synced" | "failed";
  title: string;
  error: string;
  confirmedAt: string | null;
  version: number | null;
}

interface ConnectionActivity {
  id: number;
  time: string;
  message: string;
  failed: boolean;
}

interface AgentConnectionContextValue {
  snapshot: AgentConnectionsSnapshot | undefined;
  loading: boolean;
  refreshing: boolean;
  error: string;
  stale: boolean;
  offline: boolean;
  open: boolean;
  setOpen: (value: boolean) => void;
  probing: string | null;
  probe: (id: string) => Promise<void>;
  refresh: () => void;
  sync: ContextSyncState;
  retrySync: () => void;
  activity: ConnectionActivity[];
}

const ConnectionContext = createContext<AgentConnectionContextValue | null>(null);

const PAGE_NAMES: Record<string, string> = {
  "/": "今日工作台", "/jobs": "目标岗位", "/applications": "投递进展",
  "/profile": "职业档案", "/settings": "设置", "/resume": "简历材料",
  "/interview": "面试", "/email": "邮箱", "/calendar": "日程",
};

export function AgentConnectionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { selection } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeError, setProbeError] = useState("");
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [now, setNow] = useState(Date.now());
  const [retry, setRetry] = useState(0);
  const [activity, setActivity] = useState<ConnectionActivity[]>([]);
  const [sync, setSync] = useState<ContextSyncState>({
    status: "idle", title: "", error: "", confirmedAt: null, version: null,
  });
  const mounted = useRef(true);
  const sequence = useRef(0);
  const activityId = useRef(0);
  const inFlight = useRef(false);
  const probeInFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const queued = useRef<{ sequence: number; body: Record<string, unknown>; title: string } | null>(null);
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    SHOWCASE || /^\/resume\/print\//.test(pathname) ? null : "offeru-agent-connections",
    agentRuntimeApi.connections,
    { refreshInterval: 15000, dedupingInterval: 5000, errorRetryCount: 2, errorRetryInterval: 10000 },
  );

  const record = useCallback((message: string, failed = false) => {
    const event = { id: ++activityId.current, time: new Date().toISOString(), message, failed };
    setActivity((previous) => [event, ...previous].slice(0, 5));
  }, []);

  useEffect(() => {
    mounted.current = true;
    const online = () => { setOffline(false); setRetry((value) => value + 1); void mutate().catch(() => undefined); };
    const offline = () => setOffline(true);
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [mutate]);

  // A single writer drains only the latest selection. Rapid navigation cannot
  // let an older successful response overwrite the latest visible sync state.
  const flush = useCallback(async () => {
    if (inFlight.current || !mounted.current) return;
    inFlight.current = true;
    try {
      while (queued.current && mounted.current) {
        const next = queued.current;
        queued.current = null;
        const abort = new AbortController();
        controller.current = abort;
        const timeout = window.setTimeout(() => abort.abort(), 10000);
        try {
          const response = await agentRuntimeApi.syncContext(next.body, abort.signal);
          if (!response.ok || !response.outputs || !Number.isInteger(response.outputs.version)
              || response.outputs.route !== next.body.route
              || response.outputs.entity_id !== next.body.entity_id) {
            throw new Error(response.errors?.join("；") || "工作台未确认收到当前内容，请重试。");
          }
          if (mounted.current && sequence.current === next.sequence) {
            setSync({ status: "synced", title: next.title, error: "",
              confirmedAt: new Date().toISOString(), version: response.outputs.version });
            record(`工作台已收到「${next.title}」`);
          }
        } catch (cause) {
          if (mounted.current && sequence.current === next.sequence) {
            const message = abort.signal.aborted ? "同步超时，请重试。" : safeClientErrorMessage(cause, "同步失败，请重试。");
            setSync((previous) => ({ ...previous, status: "failed", title: next.title, error: message }));
            record(`「${next.title}」同步失败`, true);
          }
        } finally {
          window.clearTimeout(timeout);
        }
      }
    } finally {
      inFlight.current = false;
    }
  }, [record]);

  const payload = useMemo(() => {
    const agentContext = selection?.data?.agentContext;
    return JSON.stringify({
      scope: "default", route: pathname,
      title: selection?.title || PAGE_NAMES[pathname] || PAGE_NAMES[`/${pathname.split("/")[1]}`] || "当前页面",
      entity_type: selection?.kind || "", entity_id: selection ? String(selection.id) : "",
      context: selection ? { selected_object: {
        kind: selection.kind, title: selection.title, subtitle: selection.subtitle || "",
        ...(agentContext && typeof agentContext === "object" ? agentContext : {}),
      } } : {},
      updated_by: "ui",
    });
  }, [pathname, selection]);

  useEffect(() => {
    if (SHOWCASE || /^\/resume\/print\//.test(pathname)) {
      queued.current = null;
      sequence.current += 1;
      return;
    }
    const body = JSON.parse(payload);
    body.context.reported_at = new Date().toISOString();
    queued.current = { sequence: ++sequence.current, body, title: body.title };
    setSync((previous) => ({ ...previous, status: "syncing", title: body.title, error: "" }));
    const timer = window.setTimeout(() => void flush(), 250);
    return () => window.clearTimeout(timer);
  }, [payload, pathname, retry, flush]);

  const probe = useCallback(async (id: string) => {
    if (probeInFlight.current || SHOWCASE) return;
    probeInFlight.current = true;
    setProbing(id);
    setProbeError("");
    const label = data?.items.find((item) => item.id === id)?.name || id;
    record(`正在检查 ${label}`);
    try {
      const result = await agentRuntimeApi.probeConnection(id);
      if (!mounted.current) return;
      await mutate(result, { revalidate: false });
      const item = result.items.find((candidate) => candidate.id === id);
      record(item?.status === "ready" ? `${label} 接入检查通过` : `${label} 检查完成，查看下一步`, item?.status !== "ready");
    } catch (cause) {
      if (mounted.current) {
        setProbeError(safeClientErrorMessage(cause, "接入检查失败，请重试。"));
        record(`${label} 接入检查失败`, true);
      }
    } finally {
      probeInFlight.current = false;
      if (mounted.current) setProbing(null);
    }
  }, [data, mutate, record]);

  const refresh = useCallback(() => { setProbeError(""); void mutate().catch(() => undefined); }, [mutate]);
  const retrySync = useCallback(() => setRetry((value) => value + 1), []);
  const stale = Boolean(data && now - Date.parse(data.checked_at) > 45000);

  return (
    <ConnectionContext.Provider value={{
      snapshot: data, loading: isLoading, refreshing: isValidating,
      error: probeError || (error ? safeClientErrorMessage(error, "状态更新失败") : ""),
      stale, offline, open, setOpen, probing, probe, refresh, sync, retrySync, activity,
    }}>
      {children}
    </ConnectionContext.Provider>
  );
}

export function useAgentConnection() {
  const context = useContext(ConnectionContext);
  if (!context) throw new Error("Agent 接入状态需要工作台上下文");
  return context;
}

export function connectionTime(value?: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "尚未检查";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}
