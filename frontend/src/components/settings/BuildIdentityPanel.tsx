"use client";

import { useEffect, useState } from "react";
import { getRuntimeIdentity, type RuntimeIdentity } from "@/lib/runtimeIdentityApi";

function shown(value: string | null): string {
  return value && value.trim() && value !== "unknown" ? value : "未知";
}

function sourceLabel(identity: RuntimeIdentity): { title: string; detail: string } {
  if (identity.build_source === "package") {
    return {
      title: "安装包构建身份已读取",
      detail: "这些信息来自随应用打包的构建记录。",
    };
  }
  if (identity.build_source === "source") {
    return {
      title: "本地源码运行（未打包）",
      detail: "提交号描述当前源码版本；源码运行没有安装包构建时间。",
    };
  }
  return {
    title: "无法验证安装包身份",
    detail: "当前运行实例没有可验证的构建记录。请更新或重新安装 OfferU。",
  };
}

function dirtyLabel(value: boolean | null): string {
  if (value === true) return "构建时有未提交的源码改动";
  if (value === false) return "构建时源码工作区干净";
  return "未知";
}

export default function BuildIdentityPanel() {
  const [identity, setIdentity] = useState<RuntimeIdentity | null>(null);
  const [error, setError] = useState(false);
  const [requestId, setRequestId] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    getRuntimeIdentity().then((value) => {
      if (!cancelled) setIdentity(value);
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, [requestId]);

  const source = identity ? sourceLabel(identity) : null;
  const runtimeType = identity?.runtime_type === "desktop-sidecar"
    ? "桌面随包运行时（desktop-sidecar）"
    : identity?.runtime_type === "local"
      ? "本地源码运行时（local）"
      : "未知";

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5" data-testid="build-identity-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">应用版本与运行身份</h2>
          <p className="mt-1 text-sm text-[var(--foreground-muted)]">
            用于确认当前窗口连接的是哪一份 OfferU Runtime。
          </p>
        </div>
        <button
          type="button"
          className="bauhaus-button !px-3 !py-2 !text-xs"
          onClick={() => setRequestId((value) => value + 1)}
        >
          重新读取
        </button>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-[var(--primary-red)]" role="status">
          无法读取本机诊断信息，请稍后重新读取。
        </p>
      ) : !identity ? (
        <p className="mt-4 text-sm text-[var(--foreground-muted)]" role="status">
          正在读取应用运行身份…
        </p>
      ) : (
        <>
          <p className={`mt-4 text-sm font-semibold ${identity.build_source === "unknown" ? "text-[var(--primary-red)]" : ""}`}>
            {source?.title}
          </p>
          <p className="mt-1 text-sm text-[var(--foreground-muted)]">{source?.detail}</p>
          <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold text-[var(--foreground-muted)]">应用版本</dt>
              <dd className="mt-1 break-all">{shown(identity.version)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-[var(--foreground-muted)]">源码提交</dt>
              <dd className="mt-1 break-all font-mono text-xs">{shown(identity.commit)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-[var(--foreground-muted)]">构建时间（UTC）</dt>
              <dd className="mt-1 break-all">{shown(identity.build_timestamp)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-[var(--foreground-muted)]">运行类型</dt>
              <dd className="mt-1">{runtimeType}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-[var(--foreground-muted)]">数据位置</dt>
              <dd className="mt-1 break-all font-mono text-xs">{shown(identity.data_root)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-[var(--foreground-muted)]">源码状态</dt>
              <dd className="mt-1">{dirtyLabel(identity.dirty)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs font-semibold text-[var(--foreground-muted)]">源码指纹</dt>
              <dd className="mt-1 break-all font-mono text-xs">{shown(identity.source_fingerprint)}</dd>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
