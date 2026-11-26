// #/sync/pair?c=<code>：Agent 用 `offeru sync pair` 生成的配对链接。
// 用户只输入同步口令：解开链接里的存储桶设置（@offeru/sync 的 openPairing，和 CLI 同一个函数）
// → 和 设置 › 数据 › 云同步 一样保存（syncApi().configure）→ 立刻同步一次。
import { openPairing, isSyncError } from "@offeru/sync";

import { safeClientErrorMessage } from "@/lib/safe-error";
import { syncApi, type SyncForm, type SyncResultView } from "@/lib/syncClient";

export type PairErrorKind = "passphrase" | "expired" | "incomplete" | "other";

export class PairError extends Error {
  constructor(readonly kind: PairErrorKind, message: string) {
    super(message);
    this.name = "PairError";
  }
}

type Api = Pick<ReturnType<typeof syncApi>, "configure" | "now">;

/** The code from the hash route's query (`?c=`); empty when the link was cut off before it. */
export function pairCodeOf(search: string): string {
  return new URLSearchParams(search).get("c")?.trim() ?? "";
}

export function pairError(cause: unknown): PairError {
  if (cause instanceof PairError) return cause;
  const code = isSyncError(cause) ? cause.code : String((cause as { code?: unknown })?.code ?? "").replace(/^sync_/, "");
  if (code === "passphrase") return new PairError("passphrase", "口令不对。要和 Agent 告诉你的同步口令一字不差，区分大小写。");
  if (code === "expired") return new PairError("expired", "链接已过期。让 Agent 重新运行 offeru sync pair，发一条新链接。");
  if (code === "format") return new PairError("incomplete", "链接不完整。让 Agent 把整条链接重新发一次，一次复制完整再打开。");
  if (code === "network") return new PairError("other", "连不上存储桶。多半是存储桶还没允许这个网址跨域访问（CORS），把这句话转给 Agent 处理。");
  return new PairError("other", safeClientErrorMessage(cause, "没有连上，请让 Agent 检查同步设置"));
}

export async function completePairing(code: string, passphrase: string, api: Api = syncApi(), now?: Date): Promise<SyncResultView> {
  if (!code) throw new PairError("incomplete", "链接不完整。让 Agent 把整条链接重新发一次，一次复制完整再打开。");
  try {
    const payload = await openPairing(code, passphrase, { now });
    const form: SyncForm = {
      endpoint: payload.endpoint,
      bucket: payload.bucket,
      region: payload.region,
      accessKeyId: payload.accessKeyId,
      secretAccessKey: payload.secretAccessKey,
      prefix: payload.prefix,
      pathStyle: payload.pathStyle,
      passphrase,
    };
    await api.configure(form);
    return (await api.now()).result;
  } catch (cause) {
    throw pairError(cause);
  }
}
