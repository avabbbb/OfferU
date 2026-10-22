import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { resolveApiBase } from "@/lib/apiBase";
import { liteToken, saveLiteToken } from "@/lib/liteSession";

/** `offeru start` opens #/pair/<code>; trade the one-time code for the approval token. */
export default function PairPage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
      .catch(() => (liteToken() ? navigate("/", { replace: true }) : setFailed(true)));
  }, [code, navigate]);

  return (
    <p className="p-10 text-sm text-[var(--foreground-muted)]">
      {failed ? "这个链接已失效。在终端重新运行 offeru start 即可。" : "正在打开 OfferU…"}
    </p>
  );
}
