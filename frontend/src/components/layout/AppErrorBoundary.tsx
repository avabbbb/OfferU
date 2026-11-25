import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { Copy, Download, RotateCw } from "lucide-react";

import { NaiwaThinking } from "@/components/brand/NaiwaThinking";
import { Button, StatusIsland, type IslandState } from "@/components/ui";
import { isChunkLoadError, reloadOnceForStaleChunk } from "@/lib/chunkReload";
import { downloadUserDataExport } from "@/lib/dataExport";

type Props = {
  children: ReactNode;
  /** "app": whole viewport on the wash (nothing else rendered). "route": inside the shell, sidebar stays. */
  scope?: "app" | "route";
  /** Changing it (e.g. the route path) clears the error so navigating away recovers. */
  resetKey?: string;
};
type State = { error: Error | null };

/** Catches render errors and failed lazy chunks so the user never lands on a blank page. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // A chunk from the previous deploy: one reload fetches the new build. The guard stops loops.
    if (isChunkLoadError(error) && reloadOnceForStaleChunk()) return;
    console.error("[OfferU] render error", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const card = <RecoveryCard error={error} />;
    if (this.props.scope === "route") {
      return <div className="grid min-h-[60vh] place-items-center px-4 py-10">{card}</div>;
    }
    return <div className="ou-wash offeru-viewport-min-height grid w-full place-items-center px-4 py-10">{card}</div>;
  }
}

function RecoveryCard({ error }: { error: Error }) {
  const stale = isChunkLoadError(error);
  const [island, setIsland] = useState<{ state: IslandState; text: string } | null>(null);
  const details = `${error.name}: ${error.message}\n${location.href}\n${navigator.userAgent}`;

  const exportData = async () => {
    setIsland({ state: "busy", text: "正在导出…" });
    try {
      const total = await downloadUserDataExport();
      setIsland({ state: "done", text: `已导出 ${total} 条数据` });
    } catch {
      setIsland({ state: "error", text: "导出没成功，重新加载后在设置里再试" });
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setIsland({ state: "done", text: "错误信息已复制" });
    } catch {
      setIsland({ state: "error", text: "复制失败" });
    }
  };

  return (
    <section className="ou-glass-card w-full max-w-md p-6" role="alert" data-testid="app-error-boundary" data-kind={stale ? "stale-chunk" : "render"}>
      <NaiwaThinking size={56} />
      <h1 className="mt-4 text-[length:var(--ou-type-page)] font-semibold leading-tight text-[var(--ou-text-primary)]">
        {stale ? "OfferU 刚更新了版本" : "这一页没能打开"}
      </h1>
      <p className="mt-2 text-[length:var(--ou-type-body)] leading-relaxed text-[var(--ou-text-secondary)]">
        {stale
          ? "这个标签页还停在旧版本，页面文件已经换掉了。重新加载一次就好。"
          : "页面渲染时出了错。重新加载通常能恢复；如果反复出现，先导出数据，再把错误信息发给我们。"}
        你的岗位、档案和简历都在本机，不受影响。
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => window.location.reload()} data-testid="app-error-reload">
          <RotateCw size={14} aria-hidden="true" /> 重新加载
        </Button>
        <Button variant="secondary" onClick={() => void exportData()} disabled={island?.state === "busy"}>
          <Download size={14} aria-hidden="true" /> 导出数据
        </Button>
        <Button variant="ghost" onClick={() => void copy()}>
          <Copy size={14} aria-hidden="true" /> 复制错误
        </Button>
      </div>
      {island && <div className="mt-3"><StatusIsland key={island.text} state={island.state}>{island.text}</StatusIsland></div>}
      <details className="ou-activity mt-3">
        <summary>错误详情</summary>
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-[var(--ou-radius-1)] bg-[var(--ou-bg-control)] p-3 font-[family-name:var(--ou-font-mono)] text-[length:var(--ou-type-xs)] text-[var(--ou-text-secondary)]">{details}</pre>
      </details>
    </section>
  );
}
