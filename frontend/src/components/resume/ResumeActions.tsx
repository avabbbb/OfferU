"use client";

// 页头右侧：分享 ▾（安静的文字钮）· 导出 ▾（这一屏唯一的墨黑主按钮）。编辑本来就边写边存，「立即保存」只在有没存的改动时出现，
// 把还在等停顿的改动立刻存下；导出、分享之前都先存，保证拿到的是眼前这一版。菜单走 components/ui 的 Menu。
import { ChevronDown, Copy, Download, FileImage, FileText, Share2 } from "lucide-react";
import { useState } from "react";

import { Button, Menu } from "@/components/ui";
import { exportResume } from "@/lib/resumeExport";

type Props = {
  docId: number;
  /** 有没存的改动。 */
  dirty: boolean;
  /** 立刻存下所有没存的改动。 */
  saveNow: () => Promise<void>;
  /** 当前简历的纯文本（分享 · 复制）。 */
  plainText: () => string;
};

export function ResumeActions({ docId, dirty, saveNow, plainText }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const say = (text: string) => { setStatus(text); window.setTimeout(() => setStatus((s) => (s === text ? null : s)), 2400); };
  const exportAs = async (kind: "pdf" | "png") => {
    setBusy(true);
    try {
      try {
        await saveNow();
      } catch {
        say("没存上，稍后再试");
        return;
      }
      // 网页版没有本机打印机：PDF 改走浏览器打印（另存为 PDF）。
      const outcome = await exportResume(docId, kind);
      say(outcome === "printed" ? "已打开打印，选「另存为 PDF」" : kind === "pdf" ? "正在下载 PDF…" : "正在下载 PNG…");
    } catch (error) {
      say(error instanceof Error ? error.message : "导出失败");
    } finally {
      setBusy(false);
    }
  };
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(plainText());
      say("已复制纯文本");
    } catch {
      say("浏览器不让复制，换导出 PDF 吧");
    }
  };

  return (
    <div className="re-actions">
      {status && <span className="re-actions-status" role="status">{status}</span>}
      {dirty && !status && (
        <Button variant="ghost" className="re-action-quiet" disabled={busy} title="立刻保存（平时停顿一下就会自动存）"
          onClick={async () => { setBusy(true); try { await saveNow(); say("已保存"); } catch { say("没存上，稍后再试"); } finally { setBusy(false); } }}>
          立即保存
        </Button>
      )}
      <Menu label="分享" align="end" trigger={
        <Button variant="ghost" className="re-action-quiet"><Share2 size={15} aria-hidden />分享</Button>
      } items={[
        { label: "复制为纯文本", description: "贴进网申表单、聊天框或邮件正文", icon: <Copy size={15} />, onSelect: () => void copyText() },
        { label: "下载 PDF 发给别人", description: "简历只存在这台电脑上，没有在线链接", icon: <FileText size={15} />, onSelect: () => void exportAs("pdf") },
      ]} />
      <Menu label="导出" align="end" trigger={
        <Button variant="primary" className="re-action-primary" disabled={busy}><Download size={15} aria-hidden />导出<ChevronDown size={15} aria-hidden /></Button>
      } items={[
        { label: "下载 PDF", description: "和预览一模一样，投递用这个", icon: <FileText size={15} />, onSelect: () => void exportAs("pdf") },
        { label: "下载 PNG", description: "高清长图，发微信 / 预览用", icon: <FileImage size={15} />, onSelect: () => void exportAs("png") },
      ]} />
    </div>
  );
}
