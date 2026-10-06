import { useEffect, useState } from "react";
import { request } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";

interface Props {
  baseUrl: string; apiKey: string; apiFormat: string; configId: string;
  value: string; onChange: (value: string) => void; error?: string;
}
interface Model { id: string; name: string }

export function ModelPicker({ baseUrl, apiKey, apiFormat, configId, value, onChange, error }: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [status, setStatus] = useState("填写接口地址和密钥后自动获取模型。");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [manual, setManual] = useState(false);
  useEffect(() => {
    setModels([]);
    setLoading(false);
    if (!/^https?:\/\//i.test(baseUrl.trim()) || !(apiKey.trim() || configId) || !apiFormat) {
      setStatus("填写接口地址和密钥后自动获取模型。");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setStatus("正在获取可用模型…");
      try {
        const result = await request<{ success: boolean; models: Model[]; message: string }>("/api/config/fetch-models", {
          method: "POST", body: JSON.stringify({ base_url: baseUrl.trim(), api_key: apiKey.trim(), api_format: apiFormat, config_id: configId }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!result.success) throw new Error(result.message);
        setModels(result.models);
        setStatus(result.models.length ? `已获取 ${result.models.length} 个模型，请选择。` : "服务未返回模型；可重试或手动填写模型 ID。");
      } catch (err) {
        if (!controller.signal.aborted) setStatus(safeClientErrorMessage(err, "获取失败，请重试或手动填写模型 ID。"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 800);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [baseUrl, apiKey, apiFormat, configId, revision]);
  const field = "mt-2 min-h-11 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary-blue)]";
  return <div className="space-y-2">
    <label className="block text-sm font-medium" htmlFor="embedded-model">选择模型</label>
    {!manual ? <select id="embedded-model" className={field} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={!!error} aria-describedby="model-status">
      <option value="">{loading ? "正在获取模型…" : "选择一个可用模型"}</option>
      {value && !models.some((model) => model.id === value) && <option value={value}>{value}（当前配置）</option>}
      {models.map((model) => <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}</option>)}
    </select> : <input id="embedded-model" name="model" autoComplete="off" spellCheck="false" value={value} onChange={(event) => onChange(event.target.value)} placeholder="输入服务支持的模型 ID…" className={field} aria-invalid={!!error} />}
    <p id="model-status" role="status" className="text-xs leading-relaxed text-[var(--foreground-muted)]">{status}</p>
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    <div className="flex gap-4 text-xs">
      <button type="button" disabled={loading || !baseUrl.trim() || !(apiKey.trim() || configId)} onClick={() => setRevision((current) => current + 1)} className="underline underline-offset-4 disabled:opacity-40 focus-visible:ring-2">重新获取</button>
      <button type="button" onClick={() => setManual((current) => !current)} className="text-[var(--foreground-muted)] underline underline-offset-4 focus-visible:ring-2">{manual ? "从列表选择" : "手动填写模型 ID"}</button>
    </div>
  </div>;
}
