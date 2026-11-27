import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Check, KeyRound, Loader2 } from "lucide-react";

import { Button, Field, Input } from "@/components/ui";
import { completePairing, pairCodeOf, pairError, type PairErrorKind } from "@/lib/syncPair";
import type { SyncResultView } from "@/lib/syncClient";
import "@/styles/sync-pair.css";

// #/sync/pair?c=<code>：Agent 用 `offeru sync pair` 发来的链接。
// 任务：把这台浏览器连上 Agent 那份数据。用户只做一件事：输入同步口令。
// 状态：等待口令 → 连接中（解开链接 → 连存储桶 → 第一次同步）→ 完成（拉取 N 条，去看岗位）/ 出错（口令不对 / 链接已过期 / 链接不完整）。
// 主操作只有一个墨黑按钮；成功后把配对码从地址栏去掉（replace，不留在历史里）。

type Phase = { kind: "idle" } | { kind: "working" } | { kind: "error"; error: PairErrorKind; message: string } | { kind: "done"; result: SyncResultView };

const INCOMPLETE = "链接不完整。让 Agent 把整条链接重新发一次，一次复制完整再打开。";

export default function SyncPairPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [code] = useState(() => pairCodeOf(location.search));
  const [passphrase, setPassphrase] = useState("");
  const [phase, setPhase] = useState<Phase>(code ? { kind: "idle" } : { kind: "error", error: "incomplete", message: INCOMPLETE });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = "连接 Agent 的数据 · OfferU";
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code || !passphrase || phase.kind === "working") return;
    setPhase({ kind: "working" });
    try {
      const result = await completePairing(code, passphrase);
      setPassphrase("");
      setPhase({ kind: "done", result });
      // 地址栏里只剩 #/sync/pair：配对码不留在历史记录和书签里。
      navigate("/sync/pair", { replace: true });
    } catch (cause) {
      const failure = pairError(cause);
      setPhase({ kind: "error", error: failure.kind, message: failure.message });
      requestAnimationFrame(() => input.current?.select());
    }
  };

  const working = phase.kind === "working";
  const fieldError = phase.kind === "error" && code ? phase.message : undefined;

  return (
    <main className="ou-pair-page" data-testid="sync-pair">
      <section className="ou-pair-card" aria-labelledby="sync-pair-title" data-phase={phase.kind}>
        {phase.kind === "done" ? (
          <div className="ou-pair-body" role="status">
            <span className="ou-pair-mark" data-done="" aria-hidden="true"><Check size={18} /></span>
            <h1 id="sync-pair-title" className="ou-pair-title">已经连上了</h1>
            <p className="ou-pair-lede">
              {phase.result.pulled > 0 ? <>从 Agent 那边拉取 <strong>{phase.result.pulled}</strong> 条。</> : <>Agent 那边暂时还没有数据。</>}
              以后 Agent 改完会同步一次，你打开或切回这个页面时就能看到。
            </p>
            <a className="ou-button ou-button-primary ou-pair-action" href="#/jobs" data-testid="sync-pair-jobs">
              去看岗位 <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        ) : (
          <form className="ou-pair-body" onSubmit={(event) => void submit(event)} noValidate>
            <span className="ou-pair-mark" aria-hidden="true"><KeyRound size={18} /></span>
            <h1 id="sync-pair-title" className="ou-pair-title"><span className="ou-pair-phrase">把这台浏览器</span><span className="ou-pair-phrase">连上你的 Agent 的数据</span></h1>
            <p className="ou-pair-lede">输入 Agent 告诉你的同步口令。口令只在这台浏览器里用来解密，不会发到任何服务器。</p>
            {code ? (
              <Field label="同步口令" error={fieldError} hint="区分大小写；复制粘贴最稳妥">
                {(id) => (
                  <Input
                    ref={input}
                    id={id}
                    type="password"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    enterKeyHint="go"
                    disabled={working}
                    aria-invalid={Boolean(fieldError)}
                    data-testid="sync-pair-passphrase"
                  />
                )}
              </Field>
            ) : (
              <p className="ou-pair-error" role="alert">{INCOMPLETE}</p>
            )}
            <Button variant="primary" type="submit" className="ou-pair-action" disabled={!code || !passphrase || working} data-testid="sync-pair-submit">
              {working ? <><Loader2 size={16} className="ou-pair-spin" aria-hidden="true" />正在连接，第一次同步要几秒…</> : "连接"}
            </Button>
          </form>
        )}
      </section>
      {phase.kind !== "done" && <p className="ou-pair-foot">链接 30 分钟内有效 · 数据只在这台浏览器和你自己的存储桶之间加密传输</p>}
    </main>
  );
}
