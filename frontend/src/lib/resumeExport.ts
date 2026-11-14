// 导出简历：有本机伴侣（装了 Chromium）就下载后端打印的 PDF/PNG；网页版没有打印机（接口回 501），
// PDF 改用浏览器自己的打印——把和预览同一份的 HTML 放进隐藏 iframe 调 window.print()，用户「另存为 PDF」。
import { bridgeHeaders } from "@/lib/bridge";
import { apiUrl, tool, type Doc } from "@/lib/core";
import { resolveStyle } from "@/lib/resumeStyle";

export type ExportOutcome = "downloaded" | "printed";

/** Content-Disposition 里的 filename*（UTF-8）优先，其次 filename。 */
export function dispositionName(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* 坏编码就用下面的 */ }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : fallback;
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 隐藏 iframe 里打印一份完整 HTML；title 是打印对话框里默认的文件名。打印对话框关掉后移除 iframe。 */
export function printHtml(html: string, title = "简历"): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    frame.onload = () => {
      frame.onload = null;
      const win = frame.contentWindow;
      if (!win) { frame.remove(); reject(new Error("浏览器不让打印")); return; }
      try {
        win.document.title = title;
        win.addEventListener("afterprint", () => window.setTimeout(() => frame.remove(), 0), { once: true });
        win.focus();
        win.print();
        resolve();
      } catch (error) {
        frame.remove();
        reject(error);
      }
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

/** 网页版的 PDF：取简历记录，走 POST /api/resume/render（和预览、和伴侣打印的是同一份 HTML），交给浏览器打印。 */
async function printDoc(docId: number): Promise<void> {
  const { record: doc } = await tool<{ record: Doc }>("get", { type: "doc", id: docId });
  const res = await fetch(apiUrl("/api/resume/render"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bridgeHeaders() },
    body: JSON.stringify({ resume: doc.resume ?? null, body: doc.body ?? "", style: resolveStyle(doc.style, doc.template) }),
  });
  if (!res.ok) throw new Error("渲染失败");
  await printHtml(await res.text(), (doc.title || "简历").trim() || "简历");
}

/**
 * 导出 PDF / PNG。伴侣在：下载它打印的文件。没有打印机（501）：PDF 走浏览器打印，PNG 报错让用户改用 PDF。
 */
export async function exportResume(docId: number, kind: "pdf" | "png"): Promise<ExportOutcome> {
  const res = await fetch(apiUrl(`/api/resume/${docId}/${kind}`), { headers: bridgeHeaders() });
  if (res.ok) {
    saveBlob(await res.blob(), dispositionName(res.headers.get("Content-Disposition"), `resume.${kind}`));
    return "downloaded";
  }
  if (res.status === 501 && kind === "pdf") {
    await printDoc(docId);
    return "printed";
  }
  if (res.status === 501) throw new Error("网页版导不了 PNG，请用「下载 PDF」（浏览器打印另存为 PDF）");
  const payload = await res.json().catch(() => ({}));
  throw new Error(String(payload?.detail || `导出失败（${res.status}）`));
}
