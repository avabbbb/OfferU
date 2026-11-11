"use client";

import { useEffect, useRef, useState } from "react";

import { refreshAll } from "@/lib/core";
import { buildDemoPackage, downloadJson, packageFilename, parseDemoPackage } from "@/lib/demo/package";
import { demoStore } from "@/lib/demo/store";
import {
  clearPreImportSnapshot,
  downloadDemoSnapshot,
  formatBytes,
  loadPreImportSnapshot,
  loadWebDavConfig,
  rememberPreImportSnapshot,
  saveWebDavConfig,
  testWebDav,
  uploadDemoSnapshot,
} from "@/lib/demo/sync";

type Props = { open: boolean; onClose: () => void };

export function DemoDataDialog({ open, onClose }: Props) {
  const [url, setUrl] = useState("");
  const [remoteDir, setRemoteDir] = useState("offeru");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [hasBackup, setHasBackup] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.all([loadWebDavConfig(), loadPreImportSnapshot()]).then(([config, backup]) => {
      if (!active) return;
      setUrl(config.url);
      setRemoteDir(config.remoteDir);
      setUsername(config.username);
      setPassword(config.password);
      setHasBackup(Boolean(backup));
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "读取同步配置失败");
    });
    return () => { active = false; };
  }, [open]);

  if (!open) return null;

  const persist = async () => {
    await saveWebDavConfig({ url, remoteDir, username, password });
  };

  const exportPackage = async () => {
    setError("");
    setNotice("");
    try {
      await demoStore.ready();
      downloadJson(packageFilename(), buildDemoPackage(demoStore.snapshot()));
      setNotice("数据包已下载。里面不含 API Key 和 Agent 对话。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败");
    }
  };

  const importPackage = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    setNotice("");
    if (file.size > 20 * 1024 * 1024) {
      setError("数据包超过 20 MB，先不要导入。");
      return;
    }
    setBusy("import");
    try {
      const parsed = parseDemoPackage(await file.text());
      const count = parsed.data.records.length;
      if (!window.confirm(`导入会用数据包里的 ${count} 条记录覆盖这个浏览器里的演示数据，并保留一份导入前快照。继续？`)) return;
      await demoStore.ready();
      await rememberPreImportSnapshot(demoStore.snapshot());
      await demoStore.replace(parsed.data);
      setHasBackup(true);
      await refreshAll();
      setNotice(`已导入 ${parsed.exported_at.slice(0, 16).replace("T", " ")} 的数据包。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导入失败");
    } finally {
      setBusy("");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const restore = async () => {
    if (!window.confirm("用导入前的快照覆盖当前演示数据？")) return;
    setBusy("restore");
    setError("");
    setNotice("");
    try {
      const backup = await loadPreImportSnapshot();
      if (!backup) throw new Error("没有导入前快照。");
      await demoStore.replace(backup);
      await clearPreImportSnapshot();
      setHasBackup(false);
      await refreshAll();
      setNotice("已恢复导入前的数据。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复失败");
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    setBusy("test");
    setError("");
    setNotice("");
    try {
      await persist();
      const result = await testWebDav({ url, remoteDir, username, password });
      setNotice(result.dirCreated ? "连接成功，已创建远程目录。" : "连接成功。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "连接失败");
    } finally {
      setBusy("");
    }
  };

  const upload = async () => {
    if (!window.confirm("用这个浏览器的数据覆盖 WebDAV 上的 offeru-demo.json？")) return;
    setBusy("upload");
    setError("");
    setNotice("");
    try {
      await persist();
      await demoStore.ready();
      const result = await uploadDemoSnapshot({ url, remoteDir, username, password }, demoStore.snapshot());
      setNotice(`已上传 ${result.payload.data.records.length} 条记录（${formatBytes(result.bytes)}）。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "上传失败");
    } finally {
      setBusy("");
    }
  };

  const download = async () => {
    setBusy("download");
    setError("");
    setNotice("");
    try {
      await persist();
      const remote = await downloadDemoSnapshot({ url, remoteDir, username, password });
      if (!remote) {
        setNotice("远端还没有 offeru-demo.json，先上传一次。");
        return;
      }
      const count = remote.data.records.length;
      if (!window.confirm(`下载会用远端 ${remote.exported_at.slice(0, 16).replace("T", " ")} 的 ${count} 条记录覆盖当前演示数据，并保留一份导入前快照。继续？`)) return;
      await demoStore.ready();
      await rememberPreImportSnapshot(demoStore.snapshot());
      await demoStore.replace(remote.data);
      setHasBackup(true);
      await refreshAll();
      setNotice(`已下载远端快照（${count} 条记录）。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "下载失败");
    } finally {
      setBusy("");
    }
  };

  const inputClass = "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[13px] text-[var(--foreground)] outline-none focus:border-[var(--border-strong)]";
  const buttonClass = "rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--foreground)] disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="data-dialog-title">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-opaque)] p-5 text-[13px] shadow-[0_12px_36px_var(--shadow-medium)]">
        <div className="flex items-start justify-between gap-3">
          <h2 id="data-dialog-title" className="text-[15px] font-semibold text-[var(--foreground)]">数据包与同步</h2>
          <button type="button" onClick={onClose} className="text-[var(--foreground-muted)] hover:text-[var(--foreground)]" aria-label="关闭">关闭</button>
        </div>
        <p className="mt-2 leading-relaxed text-[var(--foreground-muted)]">
          导出的是演示数据快照，不含 API Key、Agent 对话或本机 OfferU 数据库。示例数据内置在页面代码里，所有人首次打开看到相同内容；你的修改只在本浏览器。导入和 WebDAV 同步都是整包覆盖，不做字段级合并；多台设备不要同时编辑。
        </p>

        <section className="mt-4 border-t border-[var(--border)] pt-4">
          <h3 className="text-[13px] font-medium text-[var(--foreground)]">本地数据包</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void exportPackage()} disabled={Boolean(busy)} className={buttonClass}>导出 JSON</button>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)} className={buttonClass}>{busy === "import" ? "导入中…" : "导入 JSON"}</button>
            {hasBackup && <button type="button" onClick={() => void restore()} disabled={Boolean(busy)} className={buttonClass}>恢复导入前</button>}
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importPackage(event.target.files?.[0])} />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--foreground-muted)]">
            文件格式是 <code>offeru-demo-*.json</code>，可放网盘或 U 盘。导入前会在当前浏览器留一份 pre-import 快照。
          </p>
        </section>

        <section className="mt-4 border-t border-[var(--border)] pt-4">
          <h3 className="text-[13px] font-medium text-[var(--foreground)]">WebDAV 快照同步</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--foreground-muted)]">
            对齐 Flovart 的做法：浏览器直连 WebDAV，需要服务端放行 CORS 和 PROPFIND/MKCOL/PUT/GET。密码只在当前页面内存，不落盘。
          </p>
          <label className="mt-2 block text-[12px] text-[var(--foreground-muted)]">
            WebDAV 地址
            <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://dav.example.com/remote.php/dav/files/me" className={inputClass} />
          </label>
          <div className="mt-2 grid grid-cols-[1fr_1fr] gap-2">
            <label className="block text-[12px] text-[var(--foreground-muted)]">
              远程目录
              <input value={remoteDir} onChange={(event) => setRemoteDir(event.target.value)} placeholder="offeru" className={inputClass} />
            </label>
            <label className="block text-[12px] text-[var(--foreground-muted)]">
              用户名
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" className={inputClass} />
            </label>
          </div>
          <label className="mt-2 block text-[12px] text-[var(--foreground-muted)]">
            密码 / App Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" className={inputClass} placeholder="只保留在当前标签页内存" />
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void test()} disabled={Boolean(busy) || !url.trim()} className={buttonClass}>{busy === "test" ? "检查中…" : "测试连接"}</button>
            <button type="button" onClick={() => void upload()} disabled={Boolean(busy) || !url.trim()} className={buttonClass}>{busy === "upload" ? "上传中…" : "上传快照"}</button>
            <button type="button" onClick={() => void download()} disabled={Boolean(busy) || !url.trim()} className={buttonClass}>{busy === "download" ? "下载中…" : "下载快照"}</button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--foreground-muted)]">
            远端文件名：<code>offeru-demo.json</code>。上传覆盖远端，下载覆盖本机；不做自动同步，也不合并冲突。
          </p>
        </section>

        {error && <p role="alert" className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-[12px] leading-relaxed text-[var(--foreground)]">{error}</p>}
        {notice && <p role="status" className="mt-3 text-[12px] leading-relaxed text-[var(--foreground-muted)]">{notice}</p>}
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-md bg-[var(--foreground)] px-3 py-1.5 text-[12px] text-[var(--background)]">完成</button>
        </div>
      </div>
    </div>
  );
}
