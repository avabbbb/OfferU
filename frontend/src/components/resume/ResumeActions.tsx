"use client";

// 顶栏右侧三个按钮（参考 offershow）：保存 · 导出 ▾ · 分享 ▾。编辑本来就边写边存，「保存」是把还在等停顿的改动立刻存下；
// 导出、分享之前都先存，保证拿到的是眼前这一版。导出是这一屏唯一的墨黑主按钮。菜单走 components/ui 的 Menu。
import { ChevronDown, Copy, Download, FileImage, FileText, Share2 } from "lucide-react";
import { useState } from "react";

import { Button, Menu } from "@/components/ui";
import { apiUrl } from "@/lib/core";

type Props = {
  docId: number;
  /** 有没存的改动。 */
  dirty: boolean;
  /** 立刻存下所有没存的改动。 */
  saveNow: () => Promise<void>;
  /** 当前简历的纯文本（分享 · 复制）。 */
  plainText: () => string;
};

function download(href: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ResumeActions({ docId, dirty, saveNow, plainText }: Props) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const say = (text: string) => { setStatus(text); window.setTimeout(() => setStatus((s) => (s === text ? null : s)), 2400); };
  const exportAs = async (kind: "pdf" | "png") => {
    setBusy(true);
    try {
      await saveNow();
      download(apiUrl("/api/resume/" + docId + "/" + kind));
      say(kind === "pdf" ? "正在下载 PDF…" : "正在下载 PNG…");
    } catch {
      say("没存上，稍后再试");
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
      <Button variant="secondary" size="sm" disabled={!dirty || busy} title={dirty ? "立刻保存（平时停顿一下就会自动存）" : "都已保存"}
        onClick={async () => { setBusy(true); try { await saveNow(); say("已保存"); } catch { say("没存上，稍后再试"); } finally { setBusy(false); } }}>
        保存
      </Button>
      <Menu label="导出" align="end" trigger={
        <Button variant="primary" size="sm" disabled={busy}><Download size={14} aria-hidden />导出<ChevronDown size={14} aria-hidden /></Button>
      } items={[
        { label: "下载 PDF", description: "和预览一模一样，投递用这个", icon: <FileText size={15} />, onSelect: () => void exportAs("pdf") },
        { label: "下载 PNG", description: "高清长图，发微信 / 预览用", icon: <FileImage size={15} />, onSelect: () => void exportAs("png") },
      ]} />
      <Menu label="分享" align="end" trigger={
        <Button variant="secondary" size="sm"><Share2 size={14} aria-hidden />分享</Button>
      } items={[
        { label: "复制为纯文本", description: "贴进网申表单、聊天框或邮件正文", icon: <Copy size={15} />, onSelect: () => void copyText() },
        { label: "下载 PDF 发给别人", description: "简历只存在这台电脑上，没有在线链接", icon: <FileText size={15} />, onSelect: () => void exportAs("pdf") },
      ]} />
    </div>
  );
}
