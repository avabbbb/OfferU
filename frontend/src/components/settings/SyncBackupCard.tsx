"use client";

import { useRef, useState } from "react";

import { Button, Dialog, Field, Input } from "@/components/ui";
import { refreshAll } from "@/lib/core";
import { syncApi, type SyncClientError } from "@/lib/syncClient";
import { describeSyncError } from "@/lib/syncWizard";

// 加密备份包：把全部记录导出成一个 .offeru 文件（和云同步同一种端到端加密格式），
// 不需要存储桶、不联网；在网页版和桌面版之间互相导入。导入是合并：相同的记录认出来，不重复、不删除。

type Mode = "" | "export" | "import";

export function SyncBackupCard() {
  const [mode, setMode] = useState<Mode>("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title: string; hint: string; detail: string } | null>(null);
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);

  const open = (next: Mode) => {
    setMode(next);
    setPassphrase("");
    setConfirm("");
    setError(null);
    if (next !== "import") setFile(null);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "export") {
        const { blob, filename, records } = await syncApi().exportBackup(passphrase);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNote(`已导出 ${records} 条记录到 ${filename}。口令另外记好，导入时要用。`);
      } else if (file) {
        const { result } = await syncApi().importBackup(file, passphrase);
        setNote(result.pulled ? `已导入：新增或更新 ${result.pulled} 条${result.conflicts ? `，${result.conflicts} 处冲突见云同步下方` : ""}。可以在「最近改动」里撤销。` : "备份里的记录这台设备都已经有了，没有改动。");
        await refreshAll().catch(() => undefined);
      }
      setMode("");
    } catch (cause) {
      const failure = cause as SyncClientError;
      setError(describeSyncError(failure.code, failure.message));
    } finally {
      setBusy(false);
    }
  };

  const ready = mode === "export" ? passphrase.length >= 8 && confirm === passphrase : Boolean(file) && passphrase.length > 0;

  return (
    <section className="ou-sheet space-y-3 p-4" data-testid="sync-backup">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold text-[var(--ou-text-primary)]">加密备份包</h3>
          <p className="text-sm text-[var(--ou-text-secondary)]">把全部数据导出成一个加密文件（.offeru），离线也能用；网页版和桌面版之间互相导入，换电脑不用配存储桶。</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={() => open("import")}>导入</Button>
          <Button size="sm" onClick={() => open("export")}>导出加密备份</Button>
        </div>
      </div>
      {note && <p className="text-sm text-[var(--ou-text-secondary)]" role="status">{note}</p>}

      <Dialog
        open={mode !== ""}
        onOpenChange={(value) => { if (!value) setMode(""); }}
        title={mode === "export" ? "导出加密备份" : "导入加密备份"}
        description={mode === "export"
          ? "备份用这个口令加密，导入时要输入同一个口令；可以和同步口令相同。口令丢了备份就打不开。"
          : "导入会和这台设备现有的数据合并：相同的记录不会重复，什么都不会删除；每条改动都可以在「最近改动」里撤销。"}
        footer={(
          <>
            <Button variant="ghost" size="sm" onClick={() => setMode("")} disabled={busy}>取消</Button>
            <Button variant="primary" size="sm" onClick={() => void run()} disabled={busy || !ready}>
              {busy ? (mode === "export" ? "加密中…" : "导入中…") : mode === "export" ? "导出" : "导入"}
            </Button>
          </>
        )}
      >
        <div className="space-y-3">
          {mode === "import" && (
            <Field label="备份文件" hint={file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : "选择导出的 .offeru 文件"}>
              {(id) => (
                <div className="flex items-center gap-2">
                  <input id={id} ref={input} type="file" accept=".offeru,application/vnd.offeru.backup" className="sr-only" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
                  <Button size="sm" onClick={() => input.current?.click()}>{file ? "换一个文件" : "选择文件"}</Button>
                </div>
              )}
            </Field>
          )}
          <Field label={mode === "export" ? "备份口令" : "导出时设置的口令"} hint={mode === "export" ? "至少 8 位" : undefined}>
            {(id) => <Input id={id} type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="new-password" />}
          </Field>
          {mode === "export" && (
            <Field label="再输一次" error={confirm && confirm !== passphrase ? "两次输入的口令不一致" : undefined}>
              {(id) => <Input id={id} type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" />}
            </Field>
          )}
          {error && (
            <div className="space-y-1" role="alert">
              <p className="text-sm font-medium text-[var(--ou-tone-red-text)]">{error.title}</p>
              <p className="text-sm text-[var(--ou-text-secondary)]">{error.detail}</p>
              {error.hint && <p className="text-xs text-[var(--ou-text-tertiary)]">{error.hint}</p>}
            </div>
          )}
        </div>
      </Dialog>
    </section>
  );
}
