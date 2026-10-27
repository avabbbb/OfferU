"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { AlertCircle, Check, Copy, Eye, EyeOff, Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { agentBoardApi, type AgentBoardRow, type AgentBoardSnapshot, type CustomAgentInput } from "@/lib/api";
import { OFFERU_AGENT_CONNECT_PROMPT } from "@/lib/agentConnectionPrompt";
import { connectionTime } from "@/lib/agentConnection";
import { safeClientErrorMessage } from "@/lib/safe-error";

const SKILL_TEXT: Record<string, string> = { INSTALLED: "已接入", OUTDATED: "需更新", NOT_INSTALLED: "未接入", ERROR: "异常", NOT_SUPPORTED: "不支持" };
const MEMORY_TEXT: Record<AgentBoardRow["memory_status"], string> = { none: "未导入", exported: "已导出，等 Agent 写入", imported: "已导入" };
const EMPTY_FORM: CustomAgentInput = { id: "", display_name: "", executable: "", skill_root: "", memory_file: "" };
const INPUT_CLASS = "w-full rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5 text-xs text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

function connectAction(row: AgentBoardRow): "install" | "update" | "repair" {
  if (row.skill_status === "ERROR") return "repair";
  return row.skill_status === "OUTDATED" ? "update" : "install";
}

const CONNECT_LABEL = { install: "连接", update: "更新", repair: "修复" } as const;

/** The single self-routing prompt: paste it into any Agent and it picks setup, reconnect or memory import. */
export function AgentConnectPrompt() {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(OFFERU_AGENT_CONNECT_PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  return <div className="space-y-2 rounded-xl border border-[var(--border)] p-4" data-testid="agent-connect-prompt">
    <p className="text-sm font-semibold">一键复制接入提示词</p>
    <p className="text-xs leading-relaxed text-[var(--foreground-muted)]">粘贴到 Claude Code、Codex、WorkBuddy 等任意 Agent。它会自己判断是首次安装、重新连接，还是把 OfferU 记忆带进新 Agent，并在写入记忆前征求你的同意。</p>
    <Button size="sm" onPress={() => void copy()} startContent={copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}>
      {copyState === "copied" ? "已复制，去 Agent 里粘贴" : "复制提示词"}
    </Button>
    {copyState === "failed" && <p role="alert" className="text-xs text-amber-800">自动复制失败，请展开下方原文手动复制。</p>}
    <details>
      <summary className="cursor-pointer text-[11px] text-[var(--foreground-muted)]">查看提示词原文</summary>
      <textarea readOnly aria-label="OfferU 接入提示词" value={OFFERU_AGENT_CONNECT_PROMPT} rows={10} onFocus={(event) => event.currentTarget.select()}
        className="mt-2 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs leading-6 text-[var(--foreground)]" />
    </details>
  </div>;
}

function AgentForm({ initial, editing, busy, onCancel, onSave }: {
  initial: CustomAgentInput; editing: boolean; busy: boolean;
  onCancel: () => void; onSave: (value: CustomAgentInput) => void;
}) {
  const [value, setValue] = useState(initial);
  const field = (key: keyof CustomAgentInput, label: string, placeholder: string, disabled = false) => <label className="block space-y-1 text-[11px] text-[var(--foreground-muted)]">
    <span>{label}</span>
    <input className={INPUT_CLASS} value={value[key] || ""} placeholder={placeholder} disabled={disabled}
      onChange={(event) => setValue((previous) => ({ ...previous, [key]: event.target.value }))} />
  </label>;
  return <form className="space-y-2 rounded-xl border border-[var(--border)] p-4" data-testid="agent-board-form"
    onSubmit={(event) => { event.preventDefault(); onSave(value); }}>
    <p className="text-xs font-semibold">{editing ? "编辑 Agent" : "添加一个 Agent"}</p>
    <div className="grid gap-2 sm:grid-cols-2">
      {field("id", "ID（小写字母、数字、- 或 _）", "workbuddy", editing)}
      {field("display_name", "名称", "WorkBuddy")}
      {field("skill_root", "Skill 目录（用户目录下的绝对路径）", "~/.workbuddy/skills")}
      {field("executable", "启动命令名（只用于检测，不会执行）", "workbuddy")}
      {field("memory_file", "记忆文件（可留空）", "~/.workbuddy/MEMORY.md")}
    </div>
    <div className="flex gap-2">
      <Button size="sm" type="submit" isDisabled={busy}>{editing ? "保存" : "添加"}</Button>
      <Button size="sm" variant="light" onPress={onCancel} isDisabled={busy}>取消</Button>
    </div>
  </form>;
}

/** Board of built-in and user-added Agents: Skill connection, executable detection and memory import. */
export function AgentBoard() {
  const [board, setBoard] = useState<AgentBoardSnapshot | null>(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [form, setForm] = useState<{ initial: CustomAgentInput; editing: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await agentBoardApi.list());
      setError("");
    } catch (cause) { setError(safeClientErrorMessage(cause, "读取 Agent 看板失败，请重试。")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (id: string, action: () => Promise<unknown>, after?: () => void) => {
    setBusyId(id); setError("");
    try {
      await action();
      after?.();
      await load();
    } catch (cause) { setError(safeClientErrorMessage(cause, "操作未完成，请重试。")); }
    finally { setBusyId(""); }
  };

  const save = (value: CustomAgentInput) => {
    const editing = form?.editing || "";
    const { id, ...rest } = value;
    void run(editing || "__form", () => editing ? agentBoardApi.edit(editing, rest) : agentBoardApi.add({ ...rest, id }), () => setForm(null));
  };

  const rows = board?.agents.filter((row) => showHidden || !row.hidden) || [];
  const hiddenCount = board?.agents.filter((row) => row.hidden).length || 0;

  return <div className="space-y-3" data-testid="agent-board">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm font-semibold">Agent 看板</p>
      {board && <span role="status" className="text-[11px] text-[var(--foreground-muted)]">
        已接入 {board.summary.connected} · 需处理 {board.summary.needs_attention} · 本机检测到 {board.summary.detected}
      </span>}
    </div>
    {!board && !error && <p role="status" className="flex items-center gap-2 text-xs text-[var(--foreground-muted)]"><Loader2 size={14} className="motion-safe:animate-spin" />读取中…</p>}
    {rows.length > 0 && <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" aria-label="Agent 看板">
      {rows.map((row) => {
        const busy = busyId === row.id;
        const action = connectAction(row);
        return <li key={row.id} className={"space-y-2 p-4" + (row.hidden ? " opacity-60" : "")} data-testid={"agent-board-row-" + row.id}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              {row.display_name}
              {row.custom && <span className="ml-2 text-[11px] font-normal text-[var(--foreground-muted)]">自定义</span>}
              {row.hidden && <span className="ml-2 text-[11px] font-normal text-[var(--foreground-muted)]">已隐藏</span>}
            </p>
            <span role="status" className={"text-xs " + (row.skill_status === "INSTALLED" ? "text-emerald-700" : row.skill_status === "ERROR" ? "text-amber-800" : "text-[var(--foreground-muted)]")}>
              {busy ? "处理中…" : SKILL_TEXT[row.skill_status] || row.skill_status}
            </span>
          </div>
          <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-[11px] text-[var(--foreground-muted)]">
            <dt>程序</dt><dd>{row.executable_found ? "本机已检测到" : "未检测到"}</dd>
            <dt>Skill</dt><dd className="break-all">{row.skill_path}</dd>
            <dt>记忆</dt><dd className="break-all">{MEMORY_TEXT[row.memory_status]}{row.memory.target ? " · " + row.memory.target : ""}</dd>
            <dt>最后检查</dt><dd>{connectionTime(row.last_check.at)}</dd>
          </dl>
          {row.error && <p className="break-words text-[11px] text-amber-800">{row.error}</p>}
          <div className="flex flex-wrap gap-1.5">
            {row.skill_status !== "INSTALLED" && row.skill_status !== "NOT_SUPPORTED" && <Button size="sm" variant="bordered" isDisabled={Boolean(busyId)}
              onPress={() => void run(row.id, () => agentBoardApi.connect(row.id, action))}>{CONNECT_LABEL[action]}</Button>}
            <Button size="sm" variant="light" isDisabled={Boolean(busyId)} startContent={<RefreshCw size={12} />}
              onPress={() => void run(row.id, () => agentBoardApi.check(row.id))}>检查</Button>
            {row.custom && <Button size="sm" variant="light" isDisabled={Boolean(busyId)} startContent={<Pencil size={12} />}
              onPress={() => setForm({ editing: row.id, initial: { id: row.id, display_name: row.display_name, executable: row.executable, skill_root: row.skill_path.replace(/[\\/]offeru$/, ""), memory_file: row.memory_file } })}>编辑</Button>}
            <Button size="sm" variant="light" isDisabled={Boolean(busyId)} startContent={row.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
              onPress={() => void run(row.id, () => agentBoardApi.setHidden(row.id, !row.hidden))}>{row.hidden ? "显示" : "隐藏"}</Button>
            {row.custom && <Button size="sm" variant="light" color="danger" isDisabled={Boolean(busyId)} startContent={<Trash2 size={12} />}
              onPress={() => { if (window.confirm("从看板移除 " + row.display_name + "？已装进它的 OfferU Skill 不会被删除。")) void run(row.id, () => agentBoardApi.remove(row.id)); }}>移除</Button>}
          </div>
        </li>;
      })}
    </ul>}
    {error && <p role="alert" className="flex gap-2 text-xs text-amber-800"><AlertCircle size={14} />{error}</p>}
    {form ? <AgentForm key={form.editing || "new"} initial={form.initial} editing={Boolean(form.editing)} busy={Boolean(busyId)}
      onCancel={() => setForm(null)} onSave={save} />
      : <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="bordered" startContent={<Plus size={14} />} onPress={() => setForm({ editing: "", initial: EMPTY_FORM })}>添加 Agent</Button>
        <Button size="sm" variant="light" onPress={() => void load()} isDisabled={Boolean(busyId)} startContent={<RefreshCw size={14} />}>刷新</Button>
        {hiddenCount > 0 && <Button size="sm" variant="light" onPress={() => setShowHidden((value) => !value)}>
          {showHidden ? "收起已隐藏" : "显示已隐藏（" + hiddenCount + "）"}
        </Button>}
      </div>}
    <p className="text-[11px] leading-relaxed text-[var(--foreground-muted)]">看板只安装、更新或修复 OfferU Skill，并检测启动命令是否在 PATH 上；不会运行 Agent，也不会改它的设置或记忆文件。</p>
  </div>;
}
