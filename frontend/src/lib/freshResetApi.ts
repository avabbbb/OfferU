import { request } from "@/lib/api";

export type FreshResetResult = { backup?: { backup_id?: string } } & Record<string, unknown>;

export const freshResetApi = {
  /** Backs up, then wipes. The click (after typing the phrase) is the confirmation. */
  reset: (): Promise<FreshResetResult> =>
    request<FreshResetResult>("/api/agent/data/fresh-reset", { method: "POST" }),
};
