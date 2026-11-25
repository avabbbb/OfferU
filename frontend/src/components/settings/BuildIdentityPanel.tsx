"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { getRuntimeIdentity, type RuntimeIdentity } from "@/lib/runtimeIdentityApi";
import { SettingsGroup } from "./SettingsLayout";

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

  const rows: Array<[string, string, boolean?]> = identity ? [
    ["应用版本", shown(identity.version)],
    ["运行类型", runtimeType],
    ["源码提交", shown(identity.commit), true],
    ["构建时间（UTC）", shown(identity.build_timestamp)],
    ["源码状态", dirtyLabel(identity.dirty)],
    ["数据位置", shown(identity.data_root), true],
    ["源码指纹", shown(identity.source_fingerprint), true],
  ] : [];

  return (
    <SettingsGroup
      label="应用版本与运行身份"
      testId="build-identity-panel"
      note="用于确认当前窗口连接的是哪一份 OfferU Runtime。"
      action={<button type="button" className="ou-text-button" onClick={() => setRequestId((value) => value + 1)}>重新读取</button>}
    >
      {error ? (
        <p className="ou-settings-item ou-settings-error" role="status">无法读取本机诊断信息，请稍后重新读取。</p>
      ) : !identity ? (
        <p className="ou-settings-item ou-settings-status" role="status">正在读取应用运行身份…</p>
      ) : (
        <>
          <div className="ou-settings-item">
            <span className="ou-tile" aria-hidden="true"><Info size={16} /></span>
            <div className="ou-settings-item-text">
              <span className={identity.build_source === "unknown" ? "ou-settings-item-label ou-settings-error" : "ou-settings-item-label"}>{source?.title}</span>
              <span className="ou-settings-item-desc">{source?.detail}</span>
            </div>
          </div>
          <dl className="ou-settings-kv">
            {rows.map(([label, value, mono]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className={mono ? "ou-settings-mono" : undefined}>{value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </SettingsGroup>
  );
}
