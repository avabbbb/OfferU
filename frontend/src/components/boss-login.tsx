"use client";

// BOSS 直聘扫码登录：二维码由 OfferU 自带的 boss 命令生成，过期自动换新（最多 5 次）。
import { useEffect, useState } from "react";
import { bossLoginAction, getBossLogin, type BossLogin } from "@/lib/bossLogin";
import { safeClientErrorMessage } from "@/lib/safe-error";

const LIVE = new Set(["starting", "waiting", "scanned"]);

export function BossLoginPanel() {
  const [state, setState] = useState<BossLogin | null>(null);
  const [error, setError] = useState("");
  const live = !!state && LIVE.has(state.status);

  useEffect(() => {
    getBossLogin().then(setState).catch((cause) => setError(safeClientErrorMessage(cause, "读取 BOSS 登录状态失败")));
  }, []);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      getBossLogin().then(setState).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [live]);

  // 离开页面时停掉登录进程，不在后台一直换码。
  useEffect(() => () => void bossLoginAction("cancel").catch(() => undefined), []);

  const act = async (action: "start" | "cancel" | "logout") => {
    setError("");
    try {
      setState(await bossLoginAction(action));
    } catch (cause) {
      setError(safeClientErrorMessage(cause, "操作失败"));
    }
  };

  const btn = "rounded-md px-3 py-1.5 text-[13px] font-medium disabled:opacity-40";
  if (state && !state.installed) {
    return <p className="text-[13px] text-[var(--foreground-muted)]">这个版本没有带 boss 命令，请重新安装 OfferU。</p>;
  }
  return (
    <div className="space-y-3" data-testid="boss-login">
      {!live && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13.5px]">
            {state?.logged_in ? (
              <><span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" />已登录</>
            ) : (
              <span className="text-[var(--foreground-muted)]">{state?.status === "expired" ? "二维码过期了" : state?.status === "error" ? state.message : "还没登录"}</span>
            )}
          </p>
          {state?.logged_in ? (
            <button type="button" onClick={() => act("logout")} className={`${btn} text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)]`} data-testid="boss-logout">
              退出登录
            </button>
          ) : (
            <button type="button" disabled={!state} onClick={() => act("start")} className={`${btn} bg-[var(--foreground)] text-[var(--surface)]`} data-testid="boss-login-start">
              {state?.status === "expired" ? "重新获取二维码" : "扫码登录"}
            </button>
          )}
        </div>
      )}
      {live && (
        <div className="flex items-center gap-5">
          <div className="flex h-[168px] w-[168px] shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-white">
            {state?.qr ? <img src={state.qr} alt="BOSS 直聘登录二维码" className="h-[152px] w-[152px]" data-testid="boss-login-qr" /> : <span className="text-[12px] text-[var(--foreground-muted)]">正在获取…</span>}
          </div>
          <div className="space-y-1.5 text-[13.5px]">
            <p className="font-medium">{state?.status === "scanned" ? "已扫码，在手机上点「确认登录」" : "用 BOSS 直聘 App 扫一扫"}</p>
            <p className="text-[12.5px] text-[var(--foreground-muted)]">二维码过期会自动换新，最多 5 次。</p>
            <button type="button" onClick={() => act("cancel")} className={`${btn} -ml-3 text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)]`}>
              取消
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-[12.5px] text-[var(--danger,#b42318)]">{error}</p>}
    </div>
  );
}

export function BossLoginCard() {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6" data-testid="boss-login-card">
      <h2 className="text-[17px] font-semibold">BOSS 直聘</h2>
      <p className="mt-1 max-w-[640px] text-[13.5px] leading-relaxed text-[var(--foreground-muted)]">
        扫码登录后，OfferU 可以同步你的投递、面试邀请和 HR 回复。搜索、打招呼和补职位描述需要 BOSS 网页登录，暂时不支持。
      </p>
      <div className="mt-4 border-t border-[var(--border)] pt-4">
        <BossLoginPanel />
      </div>
    </section>
  );
}

/** 当前 BOSS 凭证能不能搜索、打招呼、补职位描述；读取中为 null，读不到按不能处理。 */
export function useBossSearchAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    getBossLogin()
      .then((state) => alive && setAvailable(state.capabilities.search))
      .catch(() => alive && setAvailable(false));
    return () => {
      alive = false;
    };
  }, []);
  return available;
}
