import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui";
import { resolveApiBase } from "@/lib/apiBase";
import { LOCAL_BRIDGE_BASE, bridgeActive, pairLocalBridgeWithCode } from "@/lib/bridge";
import { refreshAll } from "@/lib/core";
import { liteToken, saveLiteToken } from "@/lib/liteSession";
import { LOCAL_WEB } from "@/lib/local/mode";

/** `offeru start` / `offeru start --web` opens #/pair/<code>; trade the one-time code for the token. */
export default function PairPage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const crossOriginWebBridge = LOCAL_WEB && typeof window !== "undefined" && window.location.origin !== LOCAL_BRIDGE_BASE;

  useEffect(() => {
    let active = true;
    if (crossOriginWebBridge) {
      pairLocalBridgeWithCode(code)
        .then(async () => {
          if (!active) return;
          await refreshAll();
          navigate("/settings?section=agent", { replace: true });
        })
        .catch((cause) => {
          if (!active) return;
          if (bridgeActive()) {
            navigate("/settings?section=agent", { replace: true });
            return;
          }
          setError(cause instanceof Error ? cause.message : "这个配对链接已失效。请在终端运行 offeru start --web 重新获取。");
        });
      return () => { active = false; };
    }

    fetch(`${resolveApiBase()}/api/ui/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        saveLiteToken((await res.json()).token);
        navigate("/", { replace: true });
      })
      // An already-paired tab reopening an old link just continues.
      .catch(() => (liteToken() ? navigate("/", { replace: true }) : setError("这个链接已失效。在终端重新运行 offeru start 即可。")));
    return () => { active = false; };
  }, [code, crossOriginWebBridge, navigate]);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-3 p-10 text-sm text-[var(--ou-text-secondary)]">
      <p role={error ? "alert" : "status"}>
        {error || (crossOriginWebBridge ? "正在连接本机 OfferU…" : "正在打开 OfferU…")}
      </p>
      {error && (
        <div>
          <Button variant="secondary" size="sm" onClick={() => navigate(crossOriginWebBridge ? "/settings?section=agent" : "/", { replace: true })}>
            返回工作台
          </Button>
        </div>
      )}
    </div>
  );
}
