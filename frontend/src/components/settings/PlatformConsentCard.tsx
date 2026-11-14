"use client";

// 登录态平台采集的同意门：读完风险和责任划分、勾选确认后才开启；条款改版后旧同意自动失效。
import { useEffect, useState } from "react";

import { request } from "@/lib/api";

type ConsentStatus = {
  version: string;
  title: string;
  risks: string[];
  duties: Record<string, string[]>;
  agreed: boolean;
  agreed_version?: string | null;
  agreed_at?: string | null;
};

const PATH = "/api/consent/platform-collect";

export function PlatformConsentCard() {
  const [st, setSt] = useState<ConsentStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (p: Promise<ConsentStatus>) => {
    setBusy(true); setError("");
    try { setSt(await p); setChecked(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void run(request<ConsentStatus>(PATH)); }, []);

  if (!st) return <section className="ou-sheet p-5 text-sm text-[var(--ou-text-secondary)]">{error || "读取中…"}</section>;

  const stale = !st.agreed && st.agreed_version && st.agreed_version !== st.version;
  return (
    <section className="space-y-4 ou-sheet p-5" data-testid="platform-consent">
      <div>
        <p className="text-xs font-medium text-[var(--foreground-muted)]">条款版本 {st.version}</p>
        <h2 className="mt-1 text-lg font-semibold">{st.title}</h2>
        <p className="mt-1 text-sm">
          {st.agreed ? "已开启 · " + (st.agreed_at ?? "") + " 同意" : stale ? "条款已更新，之前的同意已失效，请重新阅读确认。" : "未开启：读完下面的风险和责任划分并确认后才能使用。"}
        </p>
      </div>
      <div>
        <h3 className="text-sm font-semibold">风险</h3>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-[var(--foreground-soft)]">
          {st.risks.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(st.duties).map(([who, items]) => (
          <div key={who} className="rounded-[var(--ou-radius-card)] bg-[var(--ou-bg-control)] p-4">
            <h3 className="text-sm font-semibold">{who}</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-[var(--foreground-soft)]">
              {items.map((d) => <li key={d}>{d}</li>)}
            </ul>
          </div>
        ))}
      </div>
      {st.agreed ? (
        <button type="button" disabled={busy} onClick={() => void run(request<ConsentStatus>(PATH, { method: "DELETE" }))}
          className="ou-button ou-button-secondary">撤回同意并关闭</button>
      ) : (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>我已阅读并理解以上风险和责任划分，自愿使用自己的账号，并承担由此产生的账号后果。</span>
          </label>
          <button type="button" disabled={!checked || busy}
            onClick={() => void run(request<ConsentStatus>(PATH, { method: "POST", body: JSON.stringify({ version: st.version }) }))}
            className="rounded-lg bg-[var(--foreground)] px-4 py-2 text-sm text-[var(--surface)] disabled:opacity-40">同意并开启</button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
