"use client";

import { useEffect, useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { AlertCircle, Check, LoaderCircle, X } from "lucide-react";
import { getCareerArtifact, type CareerArtifact } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { deliveryTypeLabel } from "@/components/career/deliveries";

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false });

export function ArtifactViewer({
  artifactId,
  onClose,
}: {
  artifactId: string;
  onClose: () => void;
}) {
  const [artifact, setArtifact] = useState<CareerArtifact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!artifactId) return;
    let active = true;
    setArtifact(null);
    setLoading(true);
    setError("");
    getCareerArtifact(artifactId)
      .then((result) => {
        if (!active) return;
        if (!result || !String(result.id || "").trim()) {
          throw new Error("交付物读取结果不完整");
        }
        setArtifact(result);
      })
      .catch((loadError) => {
        if (active) setError(safeClientErrorMessage(loadError, "这份交付物暂时无法读取"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [artifactId]);

  const stale = artifact?.delivery?.state === "stale";
  const html = useMemo(
    () => markdown.render(stale ? "" : artifact?.content_markdown || ""),
    [artifact?.content_markdown, stale],
  );
  const noExternalAction = artifact?.artifact_type === "follow_up_draft"
    || artifact?.artifact_type === "reengagement_candidate";

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={artifact?.title || "OfferU 已准备的内容"}
      data-testid="prepared-artifact-viewer"
      className="w-full max-w-2xl rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-[var(--foreground-muted)]">
            {artifact?.artifact_type ? deliveryTypeLabel(artifact.artifact_type) : "OfferU 已准备的内容"}
          </p>
          <h3 className="mt-1 text-[15px] font-semibold text-[var(--foreground)]">
            {artifact?.title || (loading ? "正在读取内容…" : "交付物详情")}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭交付物"
          className="shrink-0 rounded-md border border-[var(--border)] p-1.5 text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
        >
          <X size={14} />
        </button>
      </div>

      {loading ? (
        <p className="mt-4 flex items-center gap-2 text-[12px] text-[var(--foreground-muted)]">
          <LoaderCircle size={13} className="animate-spin" /> 正在读取已保存的内容…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 flex items-center gap-2 text-[12px] text-[var(--primary-red)]">
          <AlertCircle size={13} /> {error}
        </p>
      ) : null}
      {artifact && !loading ? (
        <>
          {stale ? (
            <p role="alert" className="mt-3 rounded-md border border-amber-500 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">
              生成依据已变化，这份内容已过期。请重新准备后再使用。{artifact.delivery?.reason ? ` ${artifact.delivery.reason}` : ""}
            </p>
          ) : (
            <div
              className="prose-chat mt-3 max-h-[60vh] overflow-y-auto rounded-md border border-[var(--border)] bg-white px-3 py-2 text-[13px] leading-6"
              // markdown-it 的 html:false 会转义 Agent 原文中的 HTML；只注入它生成的 Markdown HTML。
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
          {noExternalAction ? (
            <p className="mt-3 flex items-center gap-1.5 rounded-md bg-[var(--surface-muted)] px-3 py-2 text-[11.5px] text-[var(--foreground-muted)]">
              <Check size={12} /> 已保存为草稿或候选；OfferU 不会自动发送、联系或提交。
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default ArtifactViewer;
