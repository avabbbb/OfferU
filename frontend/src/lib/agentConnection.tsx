import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { agentRuntimeApi } from "./api";
import { SHOWCASE } from "./showcase/router";
import { safeClientErrorMessage } from "./safe-error";
import type { AgentConnection } from "./api";
import { useWorkbench } from "./workbench";
import type { components } from "./api-types.generated";
type AgentContextRequest = components["schemas"]["AgentContextRequest"];

export interface ContextSyncState {
  status: "idle" | "syncing" | "synced" | "failed";
  title: string;
  error: string;
  confirmedAt: string | null;
  version: number | null;
}

interface AgentConnectionContextValue {
  open: boolean;
  setOpen: (value: boolean) => void;
  connection: AgentConnection | null;
  reportConnection: (connection: AgentConnection | null) => void;
  sync: ContextSyncState;
  retrySync: () => void;
}

const ConnectionContext = createContext<AgentConnectionContextValue | null>(null);

const PAGE_NAMES: Record<string, string> = {
  "/": "今日工作台", "/jobs": "目标岗位", "/applications": "投递进展",
  "/profile": "职业档案", "/settings": "设置", "/resume": "简历材料",
  "/interview": "面试", "/email": "邮箱", "/calendar": "日程",
};

// Detail routes can be opened directly without a list selection. Keep the
// current object available to the Agent just as AgentContextReporter does.
function entityFromRoute(pathname: string): { entity_type: string; entity_id: string } {
  const jobMatch = pathname.match(/^\/jobs\/(\d+)/);
  if (jobMatch) return { entity_type: "job", entity_id: jobMatch[1] };
  const resumeMatch = pathname.match(/^\/resume\/(\d+)/);
  if (resumeMatch) return { entity_type: "resume", entity_id: resumeMatch[1] };
  return { entity_type: "", entity_id: "" };
}

export function AgentConnectionProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { selection } = useWorkbench();
  const [open, setOpen] = useState(false);
  const [connection, reportConnection] = useState<AgentConnection | null>(null);
  const [retry, setRetry] = useState(0);
  const [sync, setSync] = useState<ContextSyncState>({
    status: "idle", title: "", error: "", confirmedAt: null, version: null,
  });
  const mounted = useRef(true);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const queued = useRef<{ sequence: number; body: AgentContextRequest; title: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    const online = () => setRetry((value) => value + 1);
    window.addEventListener("online", online);
    return () => {
      mounted.current = false;
      controller.current?.abort();
      window.removeEventListener("online", online);
    };
  }, []);

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
          }
        } catch (cause) {
          if (mounted.current && sequence.current === next.sequence) {
            const message = abort.signal.aborted ? "同步超时，请重试。" : safeClientErrorMessage(cause, "同步失败，请重试。");
            setSync((previous) => ({ ...previous, status: "failed", title: next.title, error: message }));
          }
        } finally {
          window.clearTimeout(timeout);
        }
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  const payload = useMemo<AgentContextRequest>(() => {
    const agentContext = selection?.data?.agentContext;
    const routeEntity = entityFromRoute(pathname);
    return {
      scope: "default", route: pathname,
      title: selection?.title || PAGE_NAMES[pathname] || PAGE_NAMES[`/${pathname.split("/")[1]}`] || "当前页面",
      entity_type: selection?.kind || routeEntity.entity_type,
      entity_id: selection ? String(selection.id) : routeEntity.entity_id,
      context: selection ? { selected_object: {
        kind: selection.kind, title: selection.title, subtitle: selection.subtitle || "",
        ...(agentContext && typeof agentContext === "object" ? agentContext : {}),
      } } : (routeEntity.entity_type ? { selected_object: {
        kind: routeEntity.entity_type, title: "", subtitle: "",
      } } : {}),
      updated_by: "ui",
    };
  }, [pathname, selection]);

  useEffect(() => {
    if (SHOWCASE || /^\/resume\/print\//.test(pathname)) {
      queued.current = null;
      sequence.current += 1;
      return;
    }
    const body = { ...payload, context: { ...payload.context, reported_at: new Date().toISOString() } };
    queued.current = { sequence: ++sequence.current, body, title: body.title };
    setSync((previous) => ({ ...previous, status: "syncing", title: body.title, error: "" }));
    const timer = window.setTimeout(() => void flush(), 250);
    return () => window.clearTimeout(timer);
  }, [payload, pathname, retry, flush]);

  const retrySync = useCallback(() => setRetry((value) => value + 1), []);

  return (
    <ConnectionContext.Provider value={{ open, setOpen, connection, reportConnection, sync, retrySync }}>
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
