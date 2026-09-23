import { useEffect, useState } from "react";
import { Button, Checkbox, Input, Textarea } from "@nextui-org/react";
import { memoryApi, type MemoryInboxItem } from "@/lib/api";
import { safeClientErrorMessage } from "@/lib/safe-error";

export function MemorySetup({ onDone, onBusy }: { onDone: () => void; onBusy: (busy: boolean) => void }) {
  const [source, setSource] = useState("我选择的 AI 记忆");
  const [text, setText] = useState("");
  const [consent, setConsent] = useState(false);
  const [items, setItems] = useState<MemoryInboxItem[]>([]);
  const [sources, setSources] = useState<Awaited<ReturnType<typeof memoryApi.localSources>>["items"]>([]);
  const [sourceMessage, setSourceMessage] = useState("正在查找可用的 Codex 摘要…");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void memoryApi.localSources().then((result) => {
      if (active) {
        setSources(result.items);
        setSourceMessage(result.message || (result.items.length ? "" : "未找到可读取的 Codex 摘要。其他 AI 的记忆可通过导出文件提供。"));
      }
    }).catch((cause) => {
      if (active) setSourceMessage(safeClientErrorMessage(cause, "暂时无法查找本地摘要，可以选择导出文件。"));
    });
    void memoryApi.inbox({ limit: 100 }).then((result) => {
      if (active) setItems(result.items.filter((item) => item.evidence.some((entry) => entry.observation.observation_type === "imported_memory_candidate")));
    }).catch((cause) => {
      if (active) setError(safeClientErrorMessage(cause, "未能读取上次的待审核线索，可以稍后在职业档案中查看。"));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const excerpts = [...new Set(text.split(/\r?\n/).map((line) => line.replace(/^\s*[-*+]\s+/, "").trim()).filter((line) => line && !line.startsWith("#")))];

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); onBusy(true); setError("");
    try { await action(); } catch (cause) { setError(safeClientErrorMessage(cause, "整理失败，可以重试。")); }
    finally { setBusy(false); onBusy(false); }
  };
  const readFile = async (file?: File) => {
    if (!file) return;
    if (!/\.(md|txt)$/i.test(file.name) || file.size > 80_000) { setError("请选择不超过 80 KB 的 Markdown 或文本导出。"); return; }
    await run(async () => { setText(await file.text()); setSource(file.name.slice(0, 200)); setConsent(false); });
  };
  const review = (item: MemoryInboxItem, action: "accept" | "reject") => run(async () => {
    const reviewed = await memoryApi.reviewProposal(item.id, action, "使用者在首次设置中审核 AI 记忆线索");
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, ...reviewed } : entry));
  });

  return <div className="space-y-4">
    <p className="text-sm leading-6 text-[var(--foreground-muted)]">选择从 AI 导出的职业记忆，或粘贴你愿意提供的内容。导入后先逐条审核，AI 的推测会保留为待核实线索。</p>
    {loading ? <p role="status">正在读取待审核线索…</p> : !items.length ? <>
      {sourceMessage && <p role="status" className="text-xs text-[var(--foreground-muted)]">{sourceMessage}</p>}
      {sources.map((entry) => <div key={entry.id} className="rounded-lg border border-[var(--border)] p-3 text-sm">
        <p className="font-medium">发现 {entry.name}</p>
        <p className="my-2 text-xs text-[var(--foreground-muted)]">只读取摘要供你预览；选择要保留的内容后再保存。不会读取登录凭据或完整聊天历史。</p>
        {entry.can_preview ? <button type="button" disabled={busy} className="underline" onClick={() => void run(async () => {
          const preview = await memoryApi.previewLocalSource(entry.id);
          setText(preview.text); setSource(preview.source_name); setConsent(false);
        })}>允许读取并预览</button> : <p>摘要较大，请导出你要使用的职业片段。</p>}
      </div>)}
      <Input label="来源名称" maxLength={200} value={source} onValueChange={setSource} isDisabled={busy} />
      <label className="block text-sm">选择记忆导出文件<input className="mt-2 block w-full text-xs" type="file" accept=".md,.txt" disabled={busy}
        onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
      <Textarea label="要导入的职业线索" description="每行一条；请删去不相关内容和任何密钥。只会导入这里保留的内容。" minRows={5}
        value={text} maxLength={80000} onValueChange={(value) => { setText(value); setConsent(false); }} isDisabled={busy} />
      <Checkbox isSelected={consent} onValueChange={setConsent} isDisabled={busy}>允许 OfferU 保存这 {excerpts.length} 条内容，供我审核</Checkbox>
      <Button color="primary" isLoading={busy} isDisabled={!consent || !source.trim() || !excerpts.length} onPress={() => void run(async () => {
        if (excerpts.length > 80 || excerpts.some((line) => line.length > 1000)) throw new Error("每次最多 80 条，每条最多 1000 字，请先精简内容。");
        const result = await memoryApi.importCandidates(source.trim(), excerpts);
        setItems(result.items); setText(""); setConsent(false);
      })}>整理所选记忆</Button>
    </> : <>
      <p className="text-sm">已整理 {items.length} 条线索，相同内容会自动合并。请核对来源与内容。</p>
      <ul className="max-h-64 space-y-3 overflow-y-auto">
        {items.map((item) => <li key={item.id} className="rounded-lg border border-[var(--border)] p-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{String(item.after.statement || item.title)}</p>
          <p className="mt-1 text-xs text-[var(--foreground-muted)]">{item.evidence?.[0]?.observation.source.title || source} · 待核实线索</p>
          {["pending", "deferred"].includes(item.status) ? <div className="mt-2 flex gap-3">
            <button type="button" disabled={busy} onClick={() => void review(item, "accept")} className="underline">保留为线索</button>
            <button type="button" disabled={busy} onClick={() => void review(item, "reject")} className="underline">忽略</button>
          </div> : <p className="mt-2 text-xs">{item.status === "accepted" ? "已保留为线索" : item.status === "rejected" ? "已忽略" : "已处理，可在档案中查看"}</p>}
        </li>)}
      </ul>
      <Button color="primary" isDisabled={busy} onPress={onDone}>继续，未处理的内容留待审核</Button>
    </>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}
