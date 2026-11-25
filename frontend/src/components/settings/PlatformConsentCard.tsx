"use client";

// 登录态平台采集的同意门：读完风险和责任划分、勾选确认后才开启；条款改版后旧同意自动失效。
import { useEffect, useState } from "react";

import { ShieldAlert } from "lucide-react";

import { Button, Pill, Switch } from "@/components/ui";
import { request } from "@/lib/api";
import { SettingsGroup } from "./SettingsLayout";

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

  if (!st) return <SettingsGroup testId="platform-consent"><p className={`ou-settings-item ${error ? "ou-settings-error" : "ou-settings-status"}`} role={error ? "alert" : "status"}>{error || "读取中…"}</p></SettingsGroup>;

  const stale = !st.agreed && st.agreed_version && st.agreed_version !== st.version;
  return (
    <div className="ou-settings-detail-body" data-testid="platform-consent">
      <SettingsGroup label={`条款版本 ${st.version}`}>
        <div className="ou-settings-item">
          <span className="ou-tile" aria-hidden="true"><ShieldAlert size={16} /></span>
          <div className="ou-settings-item-text">
            <span className="ou-settings-item-label">{st.title}</span>
            <span className="ou-settings-item-desc">
              {st.agreed ? "已开启 · " + (st.agreed_at ?? "") + " 同意" : stale ? "条款已更新，之前的同意已失效，请重新阅读确认。" : "读完下面的风险和责任划分并确认后才能使用。"}
            </span>
          </div>
          <div className="ou-settings-item-control">
            <Pill tone={st.agreed ? "green" : stale ? "yellow" : "gray"}>{st.agreed ? "已开启" : stale ? "需重新确认" : "未开启"}</Pill>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup label="风险">
        <ul className="ou-settings-list">
          {st.risks.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </SettingsGroup>
      {Object.entries(st.duties).map(([who, items]) => (
        <SettingsGroup key={who} label={who}>
          <ul className="ou-settings-list">
            {items.map((d) => <li key={d}>{d}</li>)}
          </ul>
        </SettingsGroup>
      ))}
      <SettingsGroup>
        {st.agreed ? (
          <div className="ou-settings-item">
            <div className="ou-settings-item-text"><span className="ou-settings-item-desc">撤回后登录态采集立即关闭，需要时可以重新开启。</span></div>
            <div className="ou-settings-item-control">
              <button type="button" disabled={busy} className="ou-text-button" data-tone="danger"
                onClick={() => void run(request<ConsentStatus>(PATH, { method: "DELETE" }))}>撤回同意并关闭</button>
            </div>
          </div>
        ) : (
          <div className="ou-settings-item">
            <label className="ou-settings-consent">
              <Switch checked={checked} onCheckedChange={setChecked} aria-label="我已阅读并理解以上风险" />
              <span>我已阅读并理解以上风险和责任划分，自愿使用自己的账号，并承担由此产生的账号后果。</span>
            </label>
            <div className="ou-settings-item-control">
              <Button variant="primary" disabled={!checked || busy}
                onClick={() => void run(request<ConsentStatus>(PATH, { method: "POST", body: JSON.stringify({ version: st.version }) }))}>同意并开启</Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="ou-settings-error px-4 pb-3">{error}</p>}
      </SettingsGroup>
    </div>
  );
}
