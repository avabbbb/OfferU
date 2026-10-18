"use client";

// boss-cli 每天同步：默认关闭，打开前必须确认账号风险。
import { useEffect, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalHeader } from "@heroui/react";
import { getBossSync, runBossSync, setBossSync, type BossSync } from "@/lib/bossSync";
import { safeClientErrorMessage } from "@/lib/safe-error";

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

export function BossSyncModal({ open, onClose, tableId, onSynced }: { open: boolean; onClose: () => void; tableId: number | null; onSynced: () => void }) {
  const [state, setState] = useState<BossSync | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    getBossSync().then(setState).catch((cause) => setError(safeClientErrorMessage(cause, "读取同步状态失败")));
  }, [open]);

  const act = async (fn: () => Promise<BossSync>, synced = false) => {
    setBusy(true);
    setError("");
    try {
      setState(await fn());
      if (synced) onSynced();
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "操作失败"));
    } finally {
      setBusy(false);
    }
  };

  const btn = "rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40";
  return (
    <Modal isOpen={open} onClose={onClose} size="lg">
      <ModalContent className="rounded-xl bg-[var(--surface)]">
        <ModalHeader className="text-[16px] font-semibold">每天同步 BOSS 记录</ModalHeader>
        <ModalBody className="pb-6 text-[13.5px] leading-relaxed text-[var(--foreground)]" data-testid="boss-sync-modal">
          <p className="text-[var(--foreground-muted)]">
            OfferU 每天调用一次你电脑上的 boss-cli，读最近一页投递记录和面试邀请，合并进当前投递表。只读，不搜索、不打招呼、不投递。
          </p>
          {state && !state.installed && (
            <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2.5">
              <p className="font-medium">这台电脑上还没有 boss 命令</p>
              <p className="mt-1 text-[var(--foreground-muted)]">在终端运行：</p>
              <pre className="mt-1 whitespace-pre-wrap font-mono text-[12.5px]">uv tool install kabi-boss-cli{"\n"}boss login</pre>
            </div>
          )}
          {state?.installed && !state.enabled && (
            <>
              <div className="rounded-lg border border-[var(--border)] px-3 py-2.5">
                <p className="font-medium">先了解风险</p>
                <p className="mt-1 text-[var(--foreground-muted)]">
                  boss-cli 用你的登录态调用 BOSS 的网页接口，这不是 BOSS 官方提供的方式。BOSS 的用户协议不允许未经许可的第三方工具接入，账号有可能被限制登录。为了尽量不像脚本，同步时间每天随机落在 10:00–21:00 之间。
                </p>
                <label className="mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="boss-sync-agree" />
                  我了解风险，账号问题由我自己承担
                </label>
              </div>
              <div className="flex justify-end">
                <button type="button" disabled={!agreed || !tableId || busy} onClick={() => act(() => setBossSync(true, tableId))} className={`${btn} bg-[var(--foreground)] text-[var(--surface)]`} data-testid="boss-sync-enable">
                  打开每天同步
                </button>
              </div>
            </>
          )}
          {state?.enabled && (
            <>
              <dl className="grid grid-cols-[88px_1fr] gap-y-1.5">
                <dt className="text-[var(--foreground-muted)]">下次同步</dt>
                <dd>{fmt(state.next_run_at) || "—"}</dd>
                <dt className="text-[var(--foreground-muted)]">上次同步</dt>
                <dd data-testid="boss-sync-last">{state.last_run_at ? `${fmt(state.last_run_at)} · ${state.last_message}` : "还没同步过"}</dd>
              </dl>
              <div className="flex justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => act(() => setBossSync(false, null))} className={`${btn} text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)]`}>
                  关闭每天同步
                </button>
                <button type="button" disabled={busy} onClick={() => act(runBossSync, true)} className={`${btn} border border-[var(--border-strong)] hover:bg-[var(--surface-muted)]`} data-testid="boss-sync-run">
                  {busy ? "正在同步…" : "现在同步一次"}
                </button>
              </div>
            </>
          )}
          {error && <p className="text-[12.5px] text-[var(--danger,#b42318)]">{error}</p>}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
