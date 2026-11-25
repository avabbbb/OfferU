import { dataSafetyApi } from "@/lib/api";

/** Download every local record as offeru-data-<stamp>.json; returns how many records went out. */
export async function downloadUserDataExport(): Promise<number> {
  const payload = await dataSafetyApi.exportUserData();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[T:.Z]/g, "-").replace(/-+$/, "");
  anchor.href = url;
  anchor.download = `offeru-data-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
  return Object.values(payload.counts || {}).reduce((sum, count) => sum + Number(count || 0), 0);
}
