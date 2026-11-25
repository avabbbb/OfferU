"use client";

import { useEffect, useState } from "react";
import { Download, HardDrive, RefreshCw } from "lucide-react";

import { Button, Pill, StatusIsland, type IslandState } from "@/components/ui";
import { downloadUserDataExport } from "@/lib/dataExport";
import { readPersistence, requestPersistentStorage, type PersistenceState } from "@/lib/local/persist";
import { safeClientErrorMessage } from "@/lib/safe-error";
import { SettingsGroup } from "./SettingsLayout";

const LABEL: Record<PersistenceState, { tone: "green" | "orange" | "gray"; text: string; detail: string }> = {
  persisted: {
    tone: "green",
    text: "已持久化",
    detail: "浏览器已承诺保留 OfferU 的数据，磁盘紧张时也不会自动清理。清除浏览器数据或卸载浏览器仍会删除，定期导出一份更稳妥。",
  },
  "best-effort": {
    tone: "orange",
    text: "可能被清理",
    detail: "浏览器还没同意长期保留：磁盘紧张，或 Safari 一段时间没打开时，岗位、档案和简历可能被清掉。建议现在导出一份 JSON，或开启云同步。",
  },
  unsupported: {
    tone: "gray",
    text: "无法确认",
    detail: "这个浏览器不支持查询存储持久化。数据仍在本机，建议定期导出一份 JSON。",
  },
};

function formatBytes(size?: number): string {
  if (size === undefined) return "—";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 设置 → 数据：网页版的数据只在这个浏览器的 IndexedDB 里，告诉用户它会不会被浏览器清掉。 */
export function StoragePersistenceCard() {
  const [info, setInfo] = useState<{ state: PersistenceState; usage?: number } | null>(null);
  const [island, setIsland] = useState<{ state: IslandState; text: string } | null>(null);

  const refresh = async () => setInfo(await readPersistence());
  useEffect(() => { void refresh(); }, []);

  const exportNow = async () => {
    setIsland({ state: "busy", text: "正在导出…" });
    try {
      const total = await downloadUserDataExport();
      setIsland({ state: "done", text: `已导出 ${total} 条数据` });
    } catch (cause) {
      setIsland({ state: "error", text: safeClientErrorMessage(cause, "导出失败，请稍后重试") });
    }
  };

  const askAgain = async () => {
    setIsland({ state: "busy", text: "正在向浏览器申请…" });
    const state = await requestPersistentStorage(true);
    await refresh();
    setIsland(state === "persisted" ? { state: "done", text: "浏览器已同意保留" } : { state: "error", text: "浏览器暂未同意，先导出一份" });
  };

  const label = info ? LABEL[info.state] : null;
  return (
    <SettingsGroup label="本机数据" testId="storage-persistence">
      <div className="ou-settings-item" data-state={info?.state ?? "loading"}>
        <span className="ou-tile" aria-hidden="true"><HardDrive size={16} /></span>
        <div className="ou-settings-item-text">
          <span className="ou-settings-item-label flex flex-wrap items-center gap-2">
            浏览器存储
            {label ? <Pill tone={label.tone}>{label.text}</Pill> : <span className="ou-skeleton inline-block h-5 w-16" />}
          </span>
          <span className="ou-settings-item-desc">
            {label?.detail ?? "正在读取浏览器存储状态…"}
            {info?.usage !== undefined && ` 已用 ${formatBytes(info.usage)}。`}
          </span>
        </div>
      </div>
      <div className="ou-settings-actions px-4 pb-3">
        <Button variant="secondary" onClick={() => void exportNow()} disabled={island?.state === "busy"}>
          <Download size={14} aria-hidden="true" /> 导出 JSON
        </Button>
        {info?.state === "best-effort" && (
          <button type="button" className="ou-text-button" onClick={() => void askAgain()} disabled={island?.state === "busy"}>
            <RefreshCw size={14} aria-hidden="true" /> 再次申请保留
          </button>
        )}
        {island && <StatusIsland key={island.text} state={island.state}>{island.text}</StatusIsland>}
      </div>
    </SettingsGroup>
  );
}
