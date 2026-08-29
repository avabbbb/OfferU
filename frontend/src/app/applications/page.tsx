"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Button,
  Checkbox,
  Chip,
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Switch,
  Textarea,
  Tooltip,
} from "@nextui-org/react";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  CopyPlus,
  ExternalLink,
  KanbanSquare,
  Mail,
  MailCheck,
  MailWarning,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShoppingCart,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import ProgressBoard from "@/components/progress-board";
import { useWorkbench } from "@/lib/workbench";
import {
  type ApplicationFieldSchema,
  type ApplicationTableRecordItem,
  createApplicationRecord,
  createApplicationTable,
  deleteApplicationRecords,
  deleteApplicationTable,
  importJobsToApplicationTable,
  importLatestExtensionBatchToApplicationTable,
  moveApplicationRecords,
  renameApplicationTable,
  syncEmails,
  updateApplicationRecordCell,
  updateApplicationTableSchema,
  updateApplicationTemplate,
  updateApplicationWorkspaceSettings,
  useApplicationTableRecords,
  useApplicationWorkspace,
  useEmailStatus,
  useJobs,
} from "@/lib/hooks";

type EditingCell = {
  recordId: number;
  fieldKey: string;
};

type OperationFeedback = {
  tone: "success" | "warning" | "error";
  message: string;
};

type AddTemplateFieldDraft = {
  label: string;
  type: ApplicationFieldSchema["type"];
  options: string;
  width: number;
  visible: boolean;
};

type InlineCellEditorProps = {
  field: ApplicationFieldSchema;
  initialValue: unknown;
  onCommit: (value: unknown) => Promise<void>;
  onClose: () => void;
  onFirstEditHint: () => void;
};

const CHECKBOX_COL_WIDTH = 48;

const FIELD_TYPE_OPTIONS: Array<{ value: ApplicationFieldSchema["type"]; label: string }> = [
  { value: "text", label: "文本" },
  { value: "long_text", label: "长文本" },
  { value: "single_select", label: "单选" },
  { value: "multi_select", label: "多选" },
  { value: "date", label: "日期" },
  { value: "datetime", label: "日期时间" },
  { value: "number", label: "数字" },
  { value: "boolean", label: "是否" },
  { value: "link", label: "链接" },
];

const SOURCE_LABEL_MAP: Record<string, string> = {
  shixiseng: "实习僧",
  zhaopin: "智联招聘",
  zhilian: "智联招聘",
  boss: "BOSS直聘",
  liepin: "猎聘",
  maimai: "脉脉",
  linkedin: "LinkedIn",
  manual: "手动",
  corporate: "企业官网",
};

function cloneSchema(schema: ApplicationFieldSchema[]): ApplicationFieldSchema[] {
  return JSON.parse(JSON.stringify(schema)) as ApplicationFieldSchema[];
}

function nextFieldKey(existing: ApplicationFieldSchema[]): string {
  const base = "custom_field_";
  let index = 1;
  const keys = new Set(existing.map((item) => item.field_key));
  while (keys.has(`${base}${index}`)) {
    index += 1;
  }
  return `${base}${index}`;
}

function formatDateOnly(value: string): string {
  const direct = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
}

function formatLinkDisplayLabel(label: string, fieldKey?: string): string {
  if (fieldKey === "job_link") {
    return "岗位链接";
  }
  const trimmed = label.trim();
  if (!trimmed) return "链接";
  return trimmed.includes("链接") ? trimmed : `${trimmed}链接`;
}

function formatValue(value: unknown, type: string, fieldKey?: string): string {
  if (type === "boolean") {
    return value ? "是" : "否";
  }
  if (Array.isArray(value)) {
    return value.join(" / ");
  }
  if (value == null) {
    return "";
  }
  const raw = String(value).trim();
  if (!raw) return "";
  if (fieldKey === "source") {
    return SOURCE_LABEL_MAP[raw.toLowerCase()] ?? raw;
  }
  if (fieldKey === "updated_at" || type === "date" || type === "datetime") {
    return formatDateOnly(raw);
  }
  return raw;
}

function InlineCellEditor({
  field,
  initialValue,
  onCommit,
  onClose,
  onFirstEditHint,
}: InlineCellEditorProps) {
  const [draft, setDraft] = useState<unknown>(initialValue);
  const [commitError, setCommitError] = useState<string | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    onFirstEditHint();
  }, [onFirstEditHint]);

  const commitAndClose = async (nextDraft: unknown = draft) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setCommitError(null);
    try {
      await onCommit(nextDraft);
      onClose();
    } catch (e) {
      // 提交失败：保留编辑器与草稿，展示错误；不能静默关闭
      //（用户会以为已保存，且异常会变成 unhandled rejection）。
      setCommitError(e instanceof Error ? e.message : String(e));
    } finally {
      savingRef.current = false;
    }
  };

  if (field.type === "long_text") {
    return (
      <Textarea
        autoFocus
        minRows={2}
        value={String(draft ?? "")}
        isInvalid={Boolean(commitError)}
        errorMessage={commitError || undefined}
        onValueChange={setDraft}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            void commitAndClose();
          }
        }}
        onBlur={() => void commitAndClose()}
        classNames={{
          inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none",
        }}
      />
    );
  }

  if (field.type === "boolean") {
    return (
      <div
        className="inline-flex"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            void commitAndClose();
          }
        }}
        onBlur={() => void commitAndClose()}
      >
        <Switch
          isSelected={Boolean(draft)}
          onValueChange={(next) => setDraft(next)}
        />
      </div>
    );
  }

  if (field.type === "single_select") {
    return (
      <Select
        autoFocus
        className="min-w-[220px]"
        isInvalid={Boolean(commitError)}
        errorMessage={commitError || undefined}
        selectedKeys={draft ? [String(draft)] : []}
        onSelectionChange={(keys) => {
          const first = Array.from(keys).at(0);
          const nextDraft = first ? String(first) : "";
          setDraft(nextDraft);
          if (first) {
            void commitAndClose(nextDraft);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            void commitAndClose();
          }
        }}
        classNames={{
          trigger: "rounded-none border border-[var(--border)] bg-white shadow-none h-10",
        }}
      >
        {field.options.map((option) => (
          <SelectItem key={option}>{option}</SelectItem>
        ))}
      </Select>
    );
  }

  return (
    <Input
      autoFocus
      value={String(Array.isArray(draft) ? draft.join(", ") : draft ?? "")}
      isInvalid={Boolean(commitError)}
      errorMessage={commitError || undefined}
      type={
        field.type === "number"
          ? "number"
          : field.type === "date"
          ? "date"
          : field.type === "datetime"
          ? "datetime-local"
          : "text"
      }
      onValueChange={(next) => {
        if (field.type === "multi_select") {
          setDraft(
            next
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          );
          return;
        }
        setDraft(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          void commitAndClose();
        }
        if (event.key === "Enter" && field.type !== "long_text") {
          event.preventDefault();
        }
      }}
      onBlur={() => void commitAndClose()}
      classNames={{
        inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none h-10",
        input: "text-sm",
      }}
    />
  );
}

export default function ApplicationsPage() {
const { data: workspace, mutate: mutateWorkspace } = useApplicationWorkspace();
const { data: emailStatus, mutate: mutateEmailStatus } = useEmailStatus();
const { select } = useWorkbench();
const searchParams = useSearchParams();
const requestedView = searchParams.get("view");
const [viewMode, setViewMode] = useState<"table" | "board">(
  requestedView === "board" ? "board" : "table",
);
const [currentTableId, setCurrentTableId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [columnWidthDrafts, setColumnWidthDrafts] = useState<Record<string, number>>({});

  const [tableModalOpen, setTableModalOpen] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const [tableActionLoading, setTableActionLoading] = useState(false);
  const [editingTableId, setEditingTableId] = useState<number | null>(null);
  const [editingTableName, setEditingTableName] = useState("");
  const [tableDeleteTarget, setTableDeleteTarget] = useState<{ id: number; name: string } | null>(null);

  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importKeyword, setImportKeyword] = useState("");
  const [importSelected, setImportSelected] = useState<Set<number>>(new Set());
  const [importTargetTableId, setImportTargetTableId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [latestExtensionImporting, setLatestExtensionImporting] = useState(false);
const [emailSyncing, setEmailSyncing] = useState(false);

  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<ApplicationFieldSchema[]>([]);
  const [settingsDraft, setSettingsDraft] = useState({
    auto_row_height: true,
    auto_column_width: true,
    delete_subtable_sync_total_default: false,
  });
  const [purgeNonTemplateFields, setPurgeNonTemplateFields] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [templateFieldModalOpen, setTemplateFieldModalOpen] = useState(false);
  const [templateFieldDraft, setTemplateFieldDraft] = useState<AddTemplateFieldDraft>({
    label: "",
    type: "text",
    options: "",
    width: 180,
    visible: true,
  });
  const [templateDeleteTargetIndex, setTemplateDeleteTargetIndex] = useState<number | null>(null);

  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editHintToastVisible, setEditHintToastVisible] = useState(false);
  const [hasShownEditHint, setHasShownEditHint] = useState(false);
  const [cellSaving, setCellSaving] = useState(false);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteFromTotal, setDeleteFromTotal] = useState(false);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveDialogTargetTableId, setMoveDialogTargetTableId] = useState<number | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [operationFeedback, setOperationFeedback] = useState<OperationFeedback | null>(null);

  useEffect(() => {
    setViewMode(requestedView === "board" ? "board" : "table");
  }, [requestedView]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    if (!workspace) return;
    const hasCurrent = workspace.tables.some((table) => table.id === currentTableId);
    if (currentTableId == null || !hasCurrent) {
      setCurrentTableId(workspace.current_table_id);
    }
    setSettingsDraft({
      auto_row_height: workspace.settings.auto_row_height,
      auto_column_width: workspace.settings.auto_column_width,
      delete_subtable_sync_total_default: workspace.settings.delete_subtable_sync_total_default,
    });
    setTemplateDraft(cloneSchema(workspace.template_schema));
    if (importTargetTableId == null) {
      setImportTargetTableId(workspace.current_table_id);
    }
  }, [workspace, currentTableId, importTargetTableId]);

  useEffect(() => {
    setSelectedIds(new Set());
    setEditingCell(null);
    setMoveDialogTargetTableId(null);
    setColumnWidthDrafts({});
  }, [currentTableId, debouncedKeyword]);

  useEffect(() => {
    if (!operationFeedback || operationFeedback.tone === "error") return;
    const timer = window.setTimeout(() => setOperationFeedback(null), 3000);
    return () => window.clearTimeout(timer);
  }, [operationFeedback]);

  useEffect(() => {
    if (!editHintToastVisible) return;
    const timer = window.setTimeout(() => setEditHintToastVisible(false), 2500);
    return () => window.clearTimeout(timer);
  }, [editHintToastVisible]);

  const { data: tablePayload, mutate: mutateRecords } = useApplicationTableRecords(
    currentTableId,
    debouncedKeyword
  );
  const { data: importJobs } = useJobs({
    page: 1,
    page_size: 40,
    keyword: importKeyword.trim() || undefined,
  });

  const tables = workspace?.tables ?? [];
  const currentTable = tablePayload?.table ?? tables.find((item) => item.id === currentTableId) ?? null;
  const records = tablePayload?.records ?? [];
  const visibleFields = useMemo(
    () => (currentTable?.schema ?? []).filter((field) => field.visible),
    [currentTable]
  );
  const allChecked = records.length > 0 && selectedIds.size === records.length;
  const hasSelection = selectedIds.size > 0;
  const currentTableIsTotal = !!currentTable?.is_total;
  const templateDeleteTarget =
    templateDeleteTargetIndex != null ? templateDraft[templateDeleteTargetIndex] ?? null : null;
  const targetMoveTables = useMemo(
    () => tables.filter((table) => table.id !== currentTableId),
    [tables, currentTableId]
  );
  const getFieldWidth = useCallback(
    (field: ApplicationFieldSchema) =>
      columnWidthDrafts[field.field_key] ?? Math.max(120, field.width),
    [columnWidthDrafts]
  );
  const fieldWidthMap = useMemo(() => {
    const pairs = visibleFields.map((field) => [field.field_key, getFieldWidth(field)] as const);
    return new Map<string, number>(pairs);
  }, [visibleFields, getFieldWidth]);
  const companyColWidth = fieldWidthMap.get("company_name") ?? 0;
  const stickyFieldLeftMap = useMemo(
    () =>
      new Map<string, number>([
        ["company_name", CHECKBOX_COL_WIDTH],
        ["job_title", CHECKBOX_COL_WIDTH + companyColWidth],
      ]),
    [companyColWidth]
  );
  const tableMinWidth = useMemo(() => {
    const fieldsWidth = visibleFields.reduce((sum, field) => sum + getFieldWidth(field), 0);
    return CHECKBOX_COL_WIDTH + fieldsWidth;
  }, [visibleFields, getFieldWidth]);

  const toSafeCount = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const toNumberArray = (value: unknown): number[] => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  };

  const refreshAll = async () => {
    await Promise.all([mutateWorkspace(), mutateRecords()]);
  };

  const closeSettingsModal = () => {
    if (workspace) {
      setSettingsDraft({
        auto_row_height: workspace.settings.auto_row_height,
        auto_column_width: workspace.settings.auto_column_width,
        delete_subtable_sync_total_default: workspace.settings.delete_subtable_sync_total_default,
      });
      setTemplateDraft(cloneSchema(workspace.template_schema));
    }
    setPurgeNonTemplateFields(false);
    setTemplateFieldModalOpen(false);
    setTemplateDeleteTargetIndex(null);
    setSettingsModalOpen(false);
  };

  const handleSchemaPatch = async (mutator: (schema: ApplicationFieldSchema[]) => void) => {
    if (!currentTableId || !currentTable) return;
    const draft = cloneSchema(currentTable.schema);
    mutator(draft);
    await updateApplicationTableSchema(currentTableId, draft);
    await refreshAll();
  };

  const startColumnResize = (
    event: { clientX: number; preventDefault: () => void; stopPropagation: () => void },
    field: ApplicationFieldSchema
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = getFieldWidth(field);
    let finalWidth = startWidth;

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      finalWidth = Math.max(120, Math.round(startWidth + pointerEvent.clientX - startX));
      setColumnWidthDrafts((current) => ({ ...current, [field.field_key]: finalWidth }));
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      if (finalWidth === startWidth) return;
      void handleSchemaPatch((schema) => {
        const item = schema.find((entry) => entry.field_key === field.field_key);
        if (item) item.width = finalWidth;
      }).finally(() => {
        setColumnWidthDrafts((current) => {
          const next = { ...current };
          delete next[field.field_key];
          return next;
        });
      });
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
  };

  const beginEditCell = (record: ApplicationTableRecordItem, field: ApplicationFieldSchema) => {
    setEditingCell({ recordId: record.id, fieldKey: field.field_key });
  };

  // 行点击 → 右侧检查器 (ADR 0031:列表 → 检查器 → 复杂编辑全屏)
  const inspectRecord = (record: ApplicationTableRecordItem) => {
    const schema = currentTable?.schema ?? [];
    const valueOf = (key: string) => record.values[key];
    const title = String(valueOf("job_title") || valueOf("position") || "投递记录");
    const company = String(valueOf("company_name") || valueOf("company") || "");
    const summaryKeys = new Set(["job_title", "position", "company_name", "company"]);
    const fields = schema
      .filter((field) => field.visible && !summaryKeys.has(field.field_key))
      .slice(0, 10)
      .map((field) => ({
        label: field.label,
        value: formatValue(valueOf(field.field_key), field.type, field.field_key),
        emphasis: field.field_key === "status" || field.field_key === "apply_status",
      }));
    if (record.is_duplicate) {
      fields.unshift({ label: "去重", value: "与其他记录重复", emphasis: true });
    }
    select({
      kind: "application",
      id: record.id,
      title,
      subtitle: company,
      data: {
        fields,
        timeline: [
          { time: formatDateOnly(record.created_at), text: "创建记录" },
          ...(record.updated_at && record.updated_at !== record.created_at
            ? [{ time: formatDateOnly(record.updated_at), text: "最近更新" }]
            : []),
        ],
      },
    });
  };

  const saveCell = async (nextValue: unknown, targetCell: EditingCell | null = editingCell) => {
    if (!targetCell) return;
    setCellSaving(true);
    try {
      await updateApplicationRecordCell(targetCell.recordId, targetCell.fieldKey, nextValue);
      await mutateRecords();
      await mutateWorkspace();
    } finally {
      setCellSaving(false);
    }
  };

  const showEditHint = () => {
    if (hasShownEditHint) return;
    setHasShownEditHint(true);
    setEditHintToastVisible(true);
  };

  const toggleSelectAll = (next: boolean) => {
    if (!next) {
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(records.map((record) => record.id)));
  };

  const toggleSelectRow = (recordId: number, next: boolean) => {
    setSelectedIds((prev) => {
      const nextSet = new Set(prev);
      if (next) {
        nextSet.add(recordId);
      } else {
        nextSet.delete(recordId);
      }
      return nextSet;
    });
  };

  const handleCreateTable = async () => {
    if (!newTableName.trim()) return;
    setTableActionLoading(true);
    try {
      await createApplicationTable(newTableName.trim());
      setNewTableName("");
      await mutateWorkspace();
    } finally {
      setTableActionLoading(false);
    }
  };

  const handleRenameTable = async (tableId: number) => {
    if (!editingTableName.trim()) return;
    setTableActionLoading(true);
    try {
      await renameApplicationTable(tableId, editingTableName.trim());
      setEditingTableId(null);
      setEditingTableName("");
      await mutateWorkspace();
      await mutateRecords();
    } finally {
      setTableActionLoading(false);
    }
  };

  const handleDeleteTable = async (tableId: number) => {
    setTableActionLoading(true);
    try {
      await deleteApplicationTable(tableId);
      await mutateWorkspace();
      await mutateRecords();
    } finally {
      setTableActionLoading(false);
    }
  };

  const openImportModal = () => {
    setImportModalOpen(true);
    setImportSelected(new Set());
    setImportKeyword("");
    if (currentTableId != null) {
      setImportTargetTableId(currentTableId);
    }
  };

  const handleImport = async () => {
    if (!importTargetTableId || importSelected.size === 0) return;
    setImporting(true);
    try {
      const selectedCount = importSelected.size;
      const result = await importJobsToApplicationTable(importTargetTableId, Array.from(importSelected));
      const created = toSafeCount(result?.created, selectedCount);
      const duplicateCreated = toSafeCount(result?.duplicate_created, 0);

      if (duplicateCreated > 0) {
        setOperationFeedback({
          tone: "warning",
          message: `成功导入 ${created} 条记录，其中 ${duplicateCreated} 条已标记为重复。`,
        });
      } else {
        setOperationFeedback({
          tone: "success",
          message: `成功导入 ${created} 条记录。`,
        });
      }

      setImportModalOpen(false);
      setImportSelected(new Set());
      await refreshAll();
    } catch (error) {
      setOperationFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "导入失败，请稍后重试。",
      });
    } finally {
      setImporting(false);
    }
  };

  const handleImportLatestExtensionBatch = async () => {
    if (!currentTableId) return;
    setLatestExtensionImporting(true);
    try {
      const result = await importLatestExtensionBatchToApplicationTable(currentTableId);
      const created = toSafeCount(result?.created, 0);
      const skippedExisting = toSafeCount(result?.skipped_existing, 0);
      const totalJobs = toSafeCount(result?.total_jobs, created + skippedExisting);
      const batchId = typeof result?.batch_id === "string" ? result.batch_id : "最近批次";

      setOperationFeedback({
        tone: created > 0 ? "success" : "warning",
        message:
          created > 0
            ? `已从插件购物车${batchId}导入 ${created} 条记录，跳过 ${skippedExisting} 条已在当前表中的岗位。下一步可以筛选投递状态并打开岗位链接。`
            : `插件购物车${batchId}中的 ${totalJobs} 条岗位已在当前表，无需重复导入。`,
      });
      await refreshAll();
    } catch (error) {
      setOperationFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "没有找到插件购物车同步批次，请先在插件购物车点击同步。",
      });
    } finally {
      setLatestExtensionImporting(false);
    }
  };

  const handleSyncEmails = async () => {
    setEmailSyncing(true);
    try {
      const result = await syncEmails();
      const synced = toSafeCount(result?.synced, result?.count ?? 0);
      setOperationFeedback({
        tone: synced > 0 ? "success" : "warning",
        message:
          synced > 0
            ? `已同步 ${synced} 封邮件，面试通知已写入看板。`
            : `邮箱同步完成，但未发现新的面试通知邮件。`,
      });
      await Promise.all([mutateEmailStatus(), refreshAll()]);
    } catch (error) {
      setOperationFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? `邮箱同步失败：${error.message}`
            : "邮箱同步失败，请稍后重试。",
      });
    } finally {
      setEmailSyncing(false);
    }
  };

  const handleCreateManualRecord = async () => {
    if (!currentTableId) return;
    await createApplicationRecord(currentTableId, {
      company_name: "",
      job_title: "",
      location: "",
      job_link: "",
      source: "",
      salary_text: "",
      updated_at: new Date().toISOString(),
    });
    await refreshAll();
  };

  const openMoveModal = () => {
    if (targetMoveTables.length === 0) return;
    setMoveDialogTargetTableId(targetMoveTables[0].id);
    setMoveModalOpen(true);
  };

  const handleMoveRecords = async () => {
    if (!currentTableId || !moveDialogTargetTableId || selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      const requestedIds = Array.from(selectedIds);
      const result = await moveApplicationRecords(currentTableId, moveDialogTargetTableId, requestedIds);
      const moved = toSafeCount(result?.moved, 0);
      const alreadyExists = toNumberArray(result?.already_exists);
      const missingFromSource = toNumberArray(result?.missing_from_source);

      if (alreadyExists.length > 0 || missingFromSource.length > 0) {
        const remaining = new Set<number>([...alreadyExists, ...missingFromSource]);
        setSelectedIds(new Set(requestedIds.filter((id) => remaining.has(id))));
        setOperationFeedback({
          tone: "warning",
          message: `已移动 ${moved} 条记录，跳过 ${alreadyExists.length + missingFromSource.length} 条冲突/无效记录。`,
        });
      } else {
        setSelectedIds(new Set());
        setOperationFeedback({
          tone: "success",
          message: `成功移动 ${moved} 条记录。`,
        });
      }

      setMoveModalOpen(false);
      setMoveDialogTargetTableId(null);
      await refreshAll();
    } catch (error) {
      setOperationFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "批量移动失败，请稍后重试。",
      });
    } finally {
      setBulkLoading(false);
    }
  };

  const handleDeleteRecords = async () => {
    if (!currentTableId || selectedIds.size === 0) return;
    setBulkLoading(true);
    try {
      await deleteApplicationRecords(currentTableId, Array.from(selectedIds), deleteFromTotal);
      setDeleteConfirmOpen(false);
      setSelectedIds(new Set());
      await refreshAll();
    } finally {
      setBulkLoading(false);
    }
  };

  const openDeleteConfirm = () => {
    setDeleteFromTotal(
      currentTableIsTotal
        ? true
        : settingsDraft.delete_subtable_sync_total_default
    );
    setDeleteConfirmOpen(true);
  };

  const openTemplateFieldModal = () => {
    setTemplateFieldDraft({
      label: "",
      type: "text",
      options: "",
      width: 180,
      visible: true,
    });
    setTemplateFieldModalOpen(true);
  };

  const addTemplateField = (draft: AddTemplateFieldDraft) => {
    const options = draft.options
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    setTemplateDraft((prev) => {
      const next = cloneSchema(prev);
      next.push({
        field_key: nextFieldKey(next),
        label: draft.label.trim() || "新字段",
        type: draft.type,
        fixed: false,
        visible: draft.visible,
        width: Math.max(120, Number(draft.width) || 120),
        options: draft.type === "single_select" || draft.type === "multi_select" ? options : [],
        order: next.length,
      });
      return next.map((item, index) => ({ ...item, order: index }));
    });
  };

  const updateTemplateField = <K extends keyof ApplicationFieldSchema,>(
    index: number,
    key: K,
    value: ApplicationFieldSchema[K]
  ) => {
    setTemplateDraft((prev) => {
      const next = cloneSchema(prev);
      const target = next[index];
      if (!target) return prev;
      next[index] = { ...target, [key]: value };
      return next;
    });
  };

  const moveTemplateField = (index: number, direction: -1 | 1) => {
    setTemplateDraft((prev) => {
      const next = cloneSchema(prev);
      const to = index + direction;
      if (to < 0 || to >= next.length) return prev;
      const [item] = next.splice(index, 1);
      next.splice(to, 0, item);
      return next.map((field, order) => ({ ...field, order }));
    });
  };

  const removeTemplateField = (index: number) => {
    setTemplateDraft((prev) => {
      const target = prev[index];
      if (!target || target.fixed) return prev;
      const next = cloneSchema(prev);
      next.splice(index, 1);
      return next.map((field, order) => ({ ...field, order }));
    });
  };

  const saveSettingsAndTemplate = async () => {
    setSettingsSaving(true);
    try {
      await updateApplicationWorkspaceSettings(settingsDraft);
      await updateApplicationTemplate(templateDraft, purgeNonTemplateFields);
      await refreshAll();
      closeSettingsModal();
    } finally {
      setSettingsSaving(false);
    }
  };

  return (
    <div className="stage-page stage-page--applications space-y-5">
      <section className="stage-hero bauhaus-panel overflow-hidden bg-[var(--surface)]">
        <div className="grid gap-4 p-6 md:grid-cols-3">
          <div className="md:col-span-2">
            <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">
              {viewMode === "board" ? "求职状态主面板" : "投递管理工作台"}
            </span>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-[var(--foreground)]">
              {viewMode === "board" ? "Pipeline" : "投递"}
            </h1>
            <p className="mt-3 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              {viewMode === "board"
                ? "岗位准备与实际投递共享同一份状态投影；只有确认过的事件才会改变正式阶段。"
                : "总表承接全量记录，子表用于分类管理。你可以在任意表编辑记录值，系统会同步到同一业务记录的其他视图。"}
            </p>
            <div className="mt-4 flex items-center gap-1">
              <Button
                size="sm"
                className={`bauhaus-button !min-h-9 !px-4 ${
                  viewMode === "table" ? "bauhaus-button-blue" : "bauhaus-button-outline"
                }`}
                onPress={() => setViewMode("table")}
                startContent={<Table2 size={13} />}
              >
                数据表
              </Button>
              <Button
                size="sm"
                className={`bauhaus-button !min-h-9 !px-4 ${
                  viewMode === "board" ? "bauhaus-button-blue" : "bauhaus-button-outline"
                }`}
                onPress={() => setViewMode("board")}
                startContent={<KanbanSquare size={13} />}
              >
                进度看板
              </Button>
            </div>
          </div>
          {viewMode === "board" ? (
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-3">
              <p className="bauhaus-label text-[var(--foreground-muted)]">状态来源</p>
              <p className="mt-2 text-base font-semibold">Job · Application · Event</p>
              <p className="mt-1 text-xs font-medium leading-relaxed text-[var(--foreground-muted)]">
                Today、Pipeline 和岗位详情读取同一份事实。
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-1">
              <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-3">
                <p className="bauhaus-label text-[var(--foreground-muted)]">总记录</p>
                <p className="mt-2 text-2xl font-semibold">{workspace?.stats.total_records ?? 0}</p>
              </div>
              <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-3">
                <p className="bauhaus-label text-[var(--foreground-muted)]">重复记录</p>
                <p className="mt-2 text-2xl font-semibold">{workspace?.stats.duplicate_records ?? 0}</p>
              </div>
              <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-3">
                <p className="bauhaus-label text-[var(--foreground-muted)]">当前表</p>
                <p className="mt-2 text-base font-semibold">{currentTable?.name ?? "-"}</p>
              </div>
            </div>
          )}
        </div>
      </section>

      {viewMode === "table" && (
      <section className="data-toolbar bauhaus-panel-sm bg-[var(--surface-muted)] p-4">
        <div className="data-toolbar-layout flex flex-col gap-3">
          <div className="data-toolbar-primary flex min-w-0 flex-col gap-2">
            <div className="data-toolbar-search w-full">
              <Input
                startContent={<Search size={14} className="text-[var(--foreground-muted)]" />}
                value={keyword}
                onValueChange={setKeyword}
                placeholder="搜索公司 / 岗位 / 地点 / 链接"
                classNames={{
                  inputWrapper: "border border-[var(--border)] bg-white shadow-none rounded-none h-11",
                  input: "text-sm font-medium",
                }}
              />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Button
                className="bauhaus-button bauhaus-button-outline !min-h-11 !px-4"
                onPress={() => setTableModalOpen(true)}
                startContent={<Table2 size={14} />}
              >
                <span className="max-w-[240px] truncate">{currentTable?.name ?? "表管理"}</span>
              </Button>
              <Button
                isIconOnly
                className="bauhaus-button bauhaus-button-outline !min-h-11 !w-11 !px-0"
                onPress={() => setTableModalOpen(true)}
                aria-label="打开表管理弹窗"
              >
                <Plus size={14} />
              </Button>
            </div>
          </div>

          <div className="data-toolbar-actions flex flex-col items-stretch gap-2">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Tooltip content="把最近一次插件购物车同步的岗位直接写入当前投递表" placement="bottom" closeDelay={120}>
                <Button
                  className="bauhaus-button bauhaus-button-outline !min-h-11 !px-4"
                  startContent={<ShoppingCart size={14} />}
                  onPress={handleImportLatestExtensionBatch}
                  isLoading={latestExtensionImporting}
                  isDisabled={!currentTableId}
                >
                  导入最近插件同步
                </Button>
              </Tooltip>
              <Tooltip
                content={
                  emailStatus?.connected
                    ? `已连接${emailStatus.imap_connected ? ` IMAP ${emailStatus.imap_user}` : " Gmail"}，点击拉取最近 7 天邮件并解析面试通知`
                    : "未连接邮箱，点击后请在「邮箱」页配置 IMAP 或 Gmail 授权"
                }
                placement="bottom"
                closeDelay={120}
              >
                <Button
                  className="bauhaus-button bauhaus-button-outline !min-h-11 !px-4"
                  startContent={
                    emailStatus?.connected ? (
                      emailSyncing ? <RefreshCw size={14} className="animate-spin" /> : <MailCheck size={14} />
                    ) : (
                      <MailWarning size={14} />
                    )
                  }
                  onPress={handleSyncEmails}
                  isLoading={emailSyncing}
                  isDisabled={!emailStatus?.connected}
                >
                  同步邮箱
                </Button>
              </Tooltip>
              <Button
                className="bauhaus-button bauhaus-button-blue !min-h-11 !px-4"
                startContent={<CopyPlus size={14} />}
                onPress={openImportModal}
              >
                快捷导入
              </Button>
              <Tooltip content="设置" placement="bottom" closeDelay={120}>
                <Button
                  isIconOnly
                  className="bauhaus-button bauhaus-button-outline !min-h-11 !w-11 !px-0"
                  onPress={() => setSettingsModalOpen(true)}
                  aria-label="投递设置"
                >
                  <Settings size={14} />
                </Button>
              </Tooltip>
            </div>
            <p className="data-toolbar-help max-w-[520px] text-xs font-medium leading-5 text-[var(--foreground-muted)]">
              插件购物车同步后可直接导入当前表；导入后检查投递状态和岗位链接。
            </p>
            <div className="data-toolbar-status flex flex-wrap items-center gap-2 text-xs font-medium leading-5">
              {emailStatus?.connected ? (
                <span className="inline-flex items-center gap-1 text-[var(--foreground-soft)]">
                  <MailCheck size={12} />
                  {emailStatus.imap_connected
                    ? `IMAP · ${emailStatus.imap_user}`
                    : "Gmail · 已授权"}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[var(--primary-red)]">
                  <MailWarning size={12} />
                  邮箱未连接 — 请在「邮箱」页配置 IMAP 或 Gmail 授权后再同步
                </span>
              )}
            </div>
          </div>
        </div>
      </section>
      )}

      {viewMode === "board" && <ProgressBoard />}

      {operationFeedback && (
        <div className="feedback-pop fixed right-4 top-4 z-50 max-w-md">
          <div
            className={`flex items-start justify-between gap-3 border px-3 py-2 text-sm shadow-sm ${
              operationFeedback.tone === "success"
                ? "border-[var(--border-strong)] bg-[var(--status-sage)] text-[var(--foreground)]"
                : operationFeedback.tone === "warning"
                ? "border-[var(--border-strong)] bg-[var(--status-blush)] text-[var(--foreground)]"
                : "border-[var(--primary-red)]/35 bg-[var(--status-blush)] text-[var(--primary-red)]"
            }`}
          >
            <div className="flex items-center gap-2">
              {operationFeedback.tone === "success" ? (
                <Check size={14} />
              ) : (
                <AlertTriangle size={14} />
              )}
              <p>{operationFeedback.message}</p>
            </div>
            <button
              type="button"
              className="border border-[var(--border)] bg-white px-2 py-0.5 text-xs font-semibold"
              onClick={() => setOperationFeedback(null)}
            >
              关闭
            </button>
          </div>
        </div>
      )}

      {viewMode === "table" && (
      <section className="data-workspace bauhaus-panel relative overflow-hidden bg-white">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--foreground-soft)]">
            <ChevronsUpDown size={14} />
            共 {records.length} 条记录
          </div>
          <div className="flex items-center gap-3">
            <p className="hidden text-xs font-medium text-[var(--foreground-muted)] lg:block">
              双击单元格可编辑；按 Esc 或点击空白处保存并退出
            </p>
            <Button
              size="sm"
              className="bauhaus-button bauhaus-button-outline !min-h-9 !px-3 !py-2 !text-[11px]"
              onPress={handleCreateManualRecord}
              startContent={<Plus size={13} />}
            >
              新增记录
            </Button>
          </div>
        </div>

        <div className="max-h-[72vh] overflow-x-auto overflow-y-auto">
          <table
            className="offeru-data-table text-left text-sm"
            style={{
              tableLayout: "fixed",
              minWidth: `${tableMinWidth}px`,
              width: `${tableMinWidth}px`,
            }}
          >
            <thead className="bg-[var(--surface-muted)]">
              <tr>
                <th
                  className="sticky left-0 top-0 z-30 border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2"
                  style={{ width: `${CHECKBOX_COL_WIDTH}px`, minWidth: `${CHECKBOX_COL_WIDTH}px` }}
                >
                  <Checkbox
                    isSelected={allChecked}
                    isIndeterminate={!allChecked && selectedIds.size > 0}
                    onValueChange={toggleSelectAll}
                    radius="none"
                  />
                </th>
                {visibleFields.map((field) => (
                  <th
                    key={field.field_key}
                    className={`relative sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 font-semibold text-[var(--foreground)] ${
                      stickyFieldLeftMap.has(field.field_key) ? "sticky z-20" : ""
                    }`}
                    style={{
                      width: `${getFieldWidth(field)}px`,
                      minWidth: `${getFieldWidth(field)}px`,
                      left: stickyFieldLeftMap.get(field.field_key),
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{field.label}</span>
                      <Dropdown>
                        <DropdownTrigger>
                          <button
                            type="button"
                            className="rounded-none border border-[var(--border)] bg-white px-1.5 py-1 text-[var(--foreground-soft)] hover:bg-[var(--surface-muted)]"
                            aria-label={`操作列-${field.label}`}
                          >
                            <MoreHorizontal size={12} />
                          </button>
                        </DropdownTrigger>
                        <DropdownMenu
                          aria-label={`字段操作-${field.field_key}`}
                          onAction={async (actionKey) => {
                            if (!currentTable) return;
                            const key = String(actionKey);
                            if (key === "hide") {
                              await handleSchemaPatch((schema) => {
                                const item = schema.find((entry) => entry.field_key === field.field_key);
                                if (item) item.visible = false;
                              });
                            } else if (key === "wider") {
                              await handleSchemaPatch((schema) => {
                                const item = schema.find((entry) => entry.field_key === field.field_key);
                                if (item) item.width += 20;
                              });
                            } else if (key === "narrower") {
                              await handleSchemaPatch((schema) => {
                                const item = schema.find((entry) => entry.field_key === field.field_key);
                                if (item) item.width = Math.max(120, item.width - 20);
                              });
                            } else if (key === "delete-custom" && !field.fixed) {
                              await handleSchemaPatch((schema) => {
                                const index = schema.findIndex((entry) => entry.field_key === field.field_key);
                                if (index >= 0) {
                                  schema.splice(index, 1);
                                  schema.forEach((entry, idx) => {
                                    entry.order = idx;
                                  });
                                }
                              });
                            }
                          }}
                        >
                          <DropdownItem key="hide">隐藏列</DropdownItem>
                          <DropdownItem key="wider">列宽 +20</DropdownItem>
                          <DropdownItem key="narrower">列宽 -20</DropdownItem>
                          {field.fixed ? (
                            <DropdownItem key="locked" isReadOnly className="text-[var(--foreground-muted)]">
                              固定字段不可删改定义
                            </DropdownItem>
                          ) : (
                            <DropdownItem key="delete-custom" className="text-[var(--primary-red)]">
                              删除自定义字段
                            </DropdownItem>
                          )}
                        </DropdownMenu>
                      </Dropdown>
                    </div>
                    <button
                      type="button"
                      className="column-resize-handle"
                      aria-label={`拖拽调整${field.label}列宽`}
                      onPointerDown={(event) => startColumnResize(event, field)}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        event.preventDefault();
                        const delta = event.key === "ArrowRight" ? 20 : -20;
                        void handleSchemaPatch((schema) => {
                          const item = schema.find((entry) => entry.field_key === field.field_key);
                          if (item) item.width = Math.max(120, getFieldWidth(field) + delta);
                        });
                      }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && (
                <tr>
                  <td colSpan={visibleFields.length + 1} className="px-4 py-10 text-center text-[var(--foreground-muted)]">
                    暂无记录。你可以手动新增，或者从快捷导入中批量添加岗位。
                  </td>
                </tr>
              )}
              {records.map((record) => (
                <tr
                  key={record.id}
                  onClick={() => inspectRecord(record)}
                  tabIndex={0}
                  aria-selected={selectedIds.has(record.id)}
                  aria-label={`查看${String(record.values.company_name || "")}${String(record.values.job_title || "投递记录")}详情`}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      inspectRecord(record);
                    }
                  }}
                  className={`offeru-data-row cursor-pointer border-b border-[var(--border)] align-top ${
                    selectedIds.has(record.id)
                      ? "bg-[var(--status-sage)]"
                      : record.is_duplicate
                        ? "bg-[var(--status-blush)]"
                        : "bg-white"
                  }`}
                >
                  <td
                    className="sticky left-0 z-20 bg-inherit px-3 py-2"
                    style={{ width: `${CHECKBOX_COL_WIDTH}px`, minWidth: `${CHECKBOX_COL_WIDTH}px` }}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Checkbox
                      isSelected={selectedIds.has(record.id)}
                      onValueChange={(next) => toggleSelectRow(record.id, next)}
                      radius="none"
                    />
                  </td>
                  {visibleFields.map((field) => {
                    const isEditing =
                      editingCell?.recordId === record.id &&
                      editingCell?.fieldKey === field.field_key;
                    const rawValue = record.values[field.field_key];
                    const displayValue = formatValue(rawValue, field.type, field.field_key);
                    const rawLinkValue = typeof rawValue === "string" ? rawValue.trim() : "";
                    const truncateWidthClass = field.type === "single_select" ? "max-w-[260px]" : "max-w-[220px]";
                    const cellClass = settingsDraft.auto_row_height
                      ? "whitespace-normal break-words"
                      : `${truncateWidthClass} truncate whitespace-nowrap`;

                    return (
                      <td
                        key={`${record.id}-${field.field_key}`}
                        className={`px-3 py-2 ${cellClass} ${stickyFieldLeftMap.has(field.field_key) ? "sticky z-10 bg-inherit" : ""}`}
                        style={{
                          width: `${getFieldWidth(field)}px`,
                          minWidth: `${getFieldWidth(field)}px`,
                          left: stickyFieldLeftMap.get(field.field_key),
                        }}
                        onClick={(event) => {
                          if (isEditing) event.stopPropagation();
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          beginEditCell(record, field);
                        }}
                      >
                        {isEditing ? (
                          <div className="space-y-1">
                            <InlineCellEditor
                              field={field}
                              initialValue={rawValue ?? (field.type === "boolean" ? false : "")}
                              onCommit={async (nextValue) => {
                                await saveCell(nextValue, { recordId: record.id, fieldKey: field.field_key });
                              }}
                              onClose={() => setEditingCell(null)}
                              onFirstEditHint={showEditHint}
                            />
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            {field.type === "link" ? (
                              rawLinkValue ? (
                                <a
                                  href={rawLinkValue}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-[var(--foreground)] hover:underline"
                                  title={rawLinkValue}
                                >
                                  <span className={cellClass}>{formatLinkDisplayLabel(field.label, field.field_key)}</span>
                                  <ExternalLink size={12} />
                                </a>
                              ) : (
                                <span className={cellClass}>-</span>
                              )
                            ) : (
                              <span className={cellClass} title={displayValue || undefined}>
                                {displayValue || "-"}
                              </span>
                            )}
                            {record.is_duplicate && field.field_key === "job_title" && (
                              <Chip
                                size="sm"
                                variant="flat"
                                className="rounded-none border border-[var(--primary-red)]/30 bg-[var(--status-blush)] text-[var(--primary-red)]"
                                startContent={<AlertTriangle size={11} />}
                              >
                                重复
                              </Chip>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      )}

      {viewMode === "table" && hasSelection && (
        <div className="fixed bottom-6 left-0 right-0 z-40 flex justify-center px-4 pointer-events-none md:left-64 md:right-auto md:w-[calc(100vw-16rem)]">
          <div className="pointer-events-auto bauhaus-panel flex w-full max-w-[980px] flex-nowrap items-center gap-3 overflow-x-auto bg-[var(--surface)] px-4 py-3">
            <p className="whitespace-nowrap text-sm font-medium text-[var(--foreground-soft)]">
              已选 <span className="font-semibold text-[var(--primary-red)]">{selectedIds.size}</span> 条记录
            </p>
            <Button
              className="bauhaus-button bauhaus-button-blue !min-h-10 !px-4 !py-2 !text-[11px]"
              startContent={<Table2 size={13} />}
              isDisabled={targetMoveTables.length === 0}
              isLoading={bulkLoading}
              onPress={openMoveModal}
            >
              移动到其他表
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-red !min-h-10 !px-4 !py-2 !text-[11px]"
              startContent={<Trash2 size={13} />}
              isLoading={bulkLoading}
              onPress={openDeleteConfirm}
            >
              删除
            </Button>
            <Button
              isIconOnly
              className="bauhaus-button bauhaus-button-outline !min-h-10 !w-10 !px-0 !py-0"
              onPress={() => setSelectedIds(new Set())}
              aria-label="关闭批量操作"
            >
              <X size={14} />
            </Button>
          </div>
        </div>
      )}

      <Modal isOpen={tableModalOpen} onClose={() => setTableModalOpen(false)} size="lg">
        <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
          <ModalHeader className="border-b border-[var(--border)]">表管理</ModalHeader>
          <ModalBody className="space-y-4 py-5">
            <div className="flex gap-2">
              <Input
                value={newTableName}
                onValueChange={setNewTableName}
                placeholder="输入新表名称"
                classNames={{
                  inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none",
                }}
              />
              <Button
                className="bauhaus-button bauhaus-button-blue !min-h-10 !px-4 !py-2 !text-[11px]"
                startContent={<Plus size={13} />}
                onPress={handleCreateTable}
                isLoading={tableActionLoading}
              >
                新建表
              </Button>
            </div>

            <div className="space-y-2">
              {tables.map((table) => (
                <div
                  key={table.id}
                  className={`bauhaus-panel-sm flex items-center justify-between gap-2 px-3 py-2 ${
                    table.id === currentTableId ? "bg-[var(--surface-muted)]" : "bg-white"
                  }`}
                >
                  <button
                    type="button"
                    className="flex flex-1 items-center justify-between text-left"
                    onClick={() => {
                      setCurrentTableId(table.id);
                      setTableModalOpen(false);
                    }}
                  >
                    <span className="truncate text-sm font-medium">
                      {table.is_total ? "总表" : table.name}
                    </span>
                    <span className="text-xs text-[var(--foreground-muted)]">{table.record_count}</span>
                  </button>
                  {table.id === currentTableId && <Check size={14} className="text-[var(--primary-red)]" />}
                  {!table.is_total && (
                    <div className="flex items-center gap-1">
                      {editingTableId === table.id ? (
                        <>
                          <Input
                            size="sm"
                            value={editingTableName}
                            onValueChange={setEditingTableName}
                            className="w-36"
                            classNames={{
                              inputWrapper:
                                "rounded-none border border-[var(--border)] bg-white shadow-none h-8 min-h-8",
                              input: "text-xs",
                            }}
                          />
                          <Button
                            size="sm"
                            className="bauhaus-button bauhaus-button-blue !min-h-8 !px-2 !py-1 !text-[10px]"
                            onPress={() => handleRenameTable(table.id)}
                            isLoading={tableActionLoading}
                          >
                            保存
                          </Button>
                        </>
                      ) : (
                        <Button
                          isIconOnly
                          size="sm"
                          className="bauhaus-button bauhaus-button-outline !min-h-8 !w-8 !px-0 !py-0 !text-[10px]"
                          onPress={() => {
                            setEditingTableId(table.id);
                            setEditingTableName(table.name);
                          }}
                        >
                          <Pencil size={12} />
                        </Button>
                      )}
                      <Button
                        isIconOnly
                        size="sm"
                        className="bauhaus-button bauhaus-button-red !min-h-8 !w-8 !px-0 !py-0 !text-[10px]"
                        onPress={() => setTableDeleteTarget({ id: table.id, name: table.name })}
                        isLoading={tableActionLoading}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)]">
            <Button className="bauhaus-button bauhaus-button-outline !min-h-10 !px-4 !py-2 !text-[11px]" onPress={() => setTableModalOpen(false)}>
              关闭
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={importModalOpen} onClose={() => setImportModalOpen(false)} size="3xl">
        <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
          <ModalHeader className="border-b border-[var(--border)]">快捷导入</ModalHeader>
          <ModalBody className="space-y-4 py-5">
            <div className="grid gap-2 md:grid-cols-[1fr_220px]">
              <Input
                value={importKeyword}
                onValueChange={setImportKeyword}
                placeholder="搜索岗位名称 / 公司"
                startContent={<Search size={14} className="text-[var(--foreground-muted)]" />}
                classNames={{
                  inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none",
                }}
              />
              <Select
                selectedKeys={importTargetTableId ? [String(importTargetTableId)] : []}
                onSelectionChange={(keys) => {
                  const first = Array.from(keys).at(0);
                  setImportTargetTableId(first ? Number(first) : null);
                }}
                classNames={{
                  trigger: "rounded-none border border-[var(--border)] bg-white shadow-none h-11",
                }}
              >
                {tables.map((table) => (
                  <SelectItem key={String(table.id)}>
                    {table.is_total ? "总表" : table.name}
                  </SelectItem>
                ))}
              </Select>
            </div>

            <div className="max-h-[380px] space-y-2 overflow-auto pr-1">
              {(importJobs?.items ?? []).map((job) => {
                const checked = importSelected.has(job.id);
                return (
                  <label
                    key={job.id}
                    className={`bauhaus-panel-sm flex cursor-pointer items-start gap-3 px-3 py-3 ${
                      checked ? "bg-[var(--surface-muted)]" : "bg-white"
                    }`}
                  >
                    <Checkbox
                      isSelected={checked}
                      onValueChange={(next) => {
                        setImportSelected((prev) => {
                          const nextSet = new Set(prev);
                          if (next) {
                            nextSet.add(job.id);
                          } else {
                            nextSet.delete(job.id);
                          }
                          return nextSet;
                        });
                      }}
                      radius="none"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-[var(--foreground)]">{job.title}</p>
                      <p className="truncate text-xs text-[var(--foreground-soft)]">{job.company} · {job.location || "未知地点"}</p>
                      <p className="truncate text-xs text-[var(--foreground-muted)]">{job.apply_url || job.url || "无岗位链接"}</p>
                    </div>
                    {job.salary_text && (
                      <Chip size="sm" variant="flat" className="rounded-none border border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground)]">
                        {job.salary_text}
                      </Chip>
                    )}
                  </label>
                );
              })}
              {(importJobs?.items ?? []).length === 0 && (
                <div className="bauhaus-panel-sm bg-white px-4 py-8 text-center text-sm text-[var(--foreground-muted)]">
                  未找到可导入岗位，请调整搜索条件。
                </div>
              )}
            </div>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)]">
            <div className="mr-auto text-sm font-medium text-[var(--foreground-soft)]">已选 {importSelected.size} 条</div>
            <Button className="bauhaus-button bauhaus-button-outline !min-h-10 !px-4 !py-2 !text-[11px]" onPress={() => setImportModalOpen(false)}>
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-blue !min-h-10 !px-4 !py-2 !text-[11px]"
              isDisabled={!importTargetTableId || importSelected.size === 0}
              isLoading={importing}
              onPress={handleImport}
            >
              导入
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={settingsModalOpen} onClose={closeSettingsModal} size="5xl" scrollBehavior="inside">
        <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
          <ModalHeader className="border-b border-[var(--border)]">投递设置</ModalHeader>
          <ModalBody className="space-y-5 py-5">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-[var(--foreground)]">模块级显示设置</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="bauhaus-panel-sm flex items-center justify-between gap-3 bg-white px-3 py-3">
                  <span className="text-sm font-medium">自动行高</span>
                  <Switch
                    isSelected={settingsDraft.auto_row_height}
                    onValueChange={(next) =>
                      setSettingsDraft((prev) => ({ ...prev, auto_row_height: next }))
                    }
                  />
                </label>
                <label className="bauhaus-panel-sm flex items-center justify-between gap-3 bg-white px-3 py-3">
                  <span className="text-sm font-medium">自动列宽</span>
                  <Switch
                    isSelected={settingsDraft.auto_column_width}
                    onValueChange={(next) =>
                      setSettingsDraft((prev) => ({ ...prev, auto_column_width: next }))
                    }
                  />
                </label>
                <label className="bauhaus-panel-sm flex items-center justify-between gap-3 bg-white px-3 py-3">
                  <span className="text-sm font-medium">子表删除默认同步总表</span>
                  <Switch
                    isSelected={settingsDraft.delete_subtable_sync_total_default}
                    onValueChange={(next) =>
                      setSettingsDraft((prev) => ({
                        ...prev,
                        delete_subtable_sync_total_default: next,
                      }))
                    }
                  />
                </label>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--foreground)]">默认投递模板（新建子表基于此模板）</h3>
                <Button
                  size="sm"
                  className="bauhaus-button bauhaus-button-outline !min-h-9 !px-3 !py-2 !text-[11px]"
                  onPress={openTemplateFieldModal}
                >
                  新增自定义字段
                </Button>
              </div>
              <div className="space-y-2">
                {templateDraft.map((field, index) => (
                  <div key={field.field_key} className="bauhaus-panel-sm grid gap-2 bg-white p-3 md:grid-cols-[180px_150px_1fr_90px_auto]">
                    <Input
                      value={field.label}
                      onValueChange={(next) => updateTemplateField(index, "label", next)}
                      isDisabled={field.fixed}
                      classNames={{
                        inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none h-9 min-h-9",
                        input: "text-xs",
                      }}
                    />
                    <Select
                      selectedKeys={[field.type]}
                      onSelectionChange={(keys) => {
                        if (field.fixed) return;
                        const first = Array.from(keys).at(0);
                        if (!first) return;
                        updateTemplateField(index, "type", String(first) as ApplicationFieldSchema["type"]);
                      }}
                      isDisabled={field.fixed}
                      classNames={{
                        trigger: "rounded-none border border-[var(--border)] bg-white shadow-none h-9 min-h-9",
                      }}
                    >
                      {FIELD_TYPE_OPTIONS.map((item) => (
                        <SelectItem key={item.value}>{item.label}</SelectItem>
                      ))}
                    </Select>
                    <Input
                      value={field.options.join(", ")}
                      onValueChange={(next) =>
                        updateTemplateField(
                          index,
                          "options",
                          next
                            .split(",")
                            .map((item) => item.trim())
                            .filter(Boolean)
                        )
                      }
                      isDisabled={field.type !== "single_select" && field.type !== "multi_select"}
                      placeholder="选项用逗号分隔"
                      classNames={{
                        inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none h-9 min-h-9",
                        input: "text-xs",
                      }}
                    />
                    <Input
                      type="number"
                      value={String(field.width)}
                      onValueChange={(next) => updateTemplateField(index, "width", Math.max(120, Number(next) || 120))}
                      classNames={{
                        inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none h-9 min-h-9",
                        input: "text-xs",
                      }}
                    />
                    <div className="flex items-center gap-1">
                      <Button
                        isIconOnly
                        size="sm"
                        className="bauhaus-button bauhaus-button-outline !min-h-8 !w-8 !px-0 !py-0 !text-[10px]"
                        onPress={() => moveTemplateField(index, -1)}
                        isDisabled={index === 0}
                      >
                        ↑
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        className="bauhaus-button bauhaus-button-outline !min-h-8 !w-8 !px-0 !py-0 !text-[10px]"
                        onPress={() => moveTemplateField(index, 1)}
                        isDisabled={index === templateDraft.length - 1}
                      >
                        ↓
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        className="bauhaus-button bauhaus-button-red !min-h-8 !w-8 !px-0 !py-0 !text-[10px]"
                        onPress={() => setTemplateDeleteTargetIndex(index)}
                        isDisabled={field.fixed}
                      >
                        <Trash2 size={11} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="bauhaus-panel-sm space-y-3 bg-[var(--status-blush)] p-3">
              <h3 className="text-sm font-semibold text-[var(--primary-red)]">同步到所有表</h3>
              <label className="flex items-center gap-2 text-sm font-medium text-[var(--foreground-soft)]">
                <Checkbox
                  isSelected={purgeNonTemplateFields}
                  onValueChange={setPurgeNonTemplateFields}
                  radius="none"
                />
                同时删除现有表中不属于模板的自定义字段及其数据（高风险）
              </label>
              <p className="text-xs font-medium text-[var(--foreground-muted)]">
                不勾选时，仅同步模板新增和结构调整；已存在于各表中的非模板字段会继续保留。
              </p>
            </section>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)]">
            <Button className="bauhaus-button bauhaus-button-outline !min-h-10 !px-4 !py-2 !text-[11px]" onPress={closeSettingsModal}>
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-blue !min-h-10 !px-4 !py-2 !text-[11px]"
              onPress={saveSettingsAndTemplate}
              isLoading={settingsSaving}
            >
              保存设置与模板
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={!!tableDeleteTarget} onClose={() => setTableDeleteTarget(null)} size="md">
        <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
          <ModalHeader className="border-b border-[var(--border)]">确认删除子表</ModalHeader>
          <ModalBody className="space-y-3 py-5">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              确认删除子表「{tableDeleteTarget?.name || "当前子表"}」吗？总表记录不会受影响。
            </p>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)]">
            <Button className="bauhaus-button bauhaus-button-outline !min-h-10 !px-4 !py-2 !text-[11px]" onPress={() => setTableDeleteTarget(null)}>
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-red !min-h-10 !px-4 !py-2 !text-[11px]"
              isLoading={tableActionLoading}
              onPress={async () => {
                if (!tableDeleteTarget) return;
                const targetId = tableDeleteTarget.id;
                setTableDeleteTarget(null);
                await handleDeleteTable(targetId);
              }}
            >
              确认删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={templateFieldModalOpen} onClose={() => setTemplateFieldModalOpen(false)} size="lg">
        <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
          <ModalHeader className="border-b border-[var(--border)]">新增自定义字段</ModalHeader>
          <ModalBody className="space-y-4 py-5">
            <Input
              label="字段名称"
              labelPlacement="outside"
              value={templateFieldDraft.label}
              onValueChange={(next) => setTemplateFieldDraft((prev) => ({ ...prev, label: next }))}
              classNames={{ inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none h-10 min-h-10" }}
            />
            <div className="grid gap-3 md:grid-cols-2">
              <Select
                label="字段类型"
                labelPlacement="outside"
                selectedKeys={[templateFieldDraft.type]}
                onSelectionChange={(keys) => {
                  const first = Array.from(keys).at(0);
                  if (!first) return;
                  setTemplateFieldDraft((prev) => ({ ...prev, type: String(first) as ApplicationFieldSchema["type"] }));
                }}
                classNames={{ trigger: "rounded-none border border-[var(--border)] bg-white shadow-none h-10 min-h-10" }}
              >
                {FIELD_TYPE_OPTIONS.map((item) => (
                  <SelectItem key={item.value}>{item.label}</SelectItem>
                ))}
              </Select>
              <Input
                type="number"
                label="默认列宽"
                labelPlacement="outside"
                value={String(templateFieldDraft.width)}
                onValueChange={(next) =>
                  setTemplateFieldDraft((prev) => ({ ...prev, width: Math.max(120, Number(next) || 120) }))
                }
                classNames={{ inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none h-10 min-h-10" }}
              />
            </div>
            <Input
              label="选项配置（单选/多选）"
              labelPlacement="outside"
              value={templateFieldDraft.options}
              onValueChange={(next) => setTemplateFieldDraft((prev) => ({ ...prev, options: next }))}
              isDisabled={templateFieldDraft.type !== "single_select" && templateFieldDraft.type !== "multi_select"}
              placeholder="例如：待投递, 已投递, 面试中"
              classNames={{ inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none h-10 min-h-10" }}
            />
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--foreground-soft)]">
              <Checkbox
                isSelected={templateFieldDraft.visible}
                onValueChange={(next) => setTemplateFieldDraft((prev) => ({ ...prev, visible: next }))}
                radius="none"
              />
              在表格中显示
            </label>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)]">
            <Button className="bauhaus-button bauhaus-button-outline !min-h-10 !px-4 !py-2 !text-[11px]" onPress={() => setTemplateFieldModalOpen(false)}>
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-blue !min-h-10 !px-4 !py-2 !text-[11px]"
              onPress={() => {
                addTemplateField(templateFieldDraft);
                setTemplateFieldModalOpen(false);
              }}
              isDisabled={!templateFieldDraft.label.trim()}
            >
              确认新增
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={templateDeleteTargetIndex != null} onClose={() => setTemplateDeleteTargetIndex(null)} size="sm">
        <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
          <ModalHeader className="border-b border-[var(--border)]">删除自定义字段</ModalHeader>
          <ModalBody className="space-y-2 py-5">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              确认删除字段「{templateDeleteTarget?.label || "当前字段"}」吗？该字段对应数据将被移除。
            </p>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)]">
            <Button className="bauhaus-button bauhaus-button-outline !min-h-10 !px-4 !py-2 !text-[11px]" onPress={() => setTemplateDeleteTargetIndex(null)}>
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-red !min-h-10 !px-4 !py-2 !text-[11px]"
              onPress={() => {
                if (templateDeleteTargetIndex == null) return;
                removeTemplateField(templateDeleteTargetIndex);
                setTemplateDeleteTargetIndex(null);
              }}
            >
              确认删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={moveModalOpen} onClose={() => setMoveModalOpen(false)} size="md">
        <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
          <ModalHeader className="border-b border-[var(--border)]">移动到其他表</ModalHeader>
          <ModalBody className="space-y-3 py-5">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              将把当前已选记录加入目标表；若目标表已存在同一记录会自动跳过。
            </p>
            <Select
              selectedKeys={moveDialogTargetTableId ? [String(moveDialogTargetTableId)] : []}
              onSelectionChange={(keys) => {
                const first = Array.from(keys).at(0);
                setMoveDialogTargetTableId(first ? Number(first) : null);
              }}
              classNames={{ trigger: "rounded-none border border-[var(--border)] bg-white shadow-none h-11" }}
              placeholder="选择目标表"
            >
              {targetMoveTables.map((table) => (
                <SelectItem key={String(table.id)}>
                  {table.is_total ? "总表" : table.name}
                </SelectItem>
              ))}
            </Select>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)]">
            <Button className="bauhaus-button bauhaus-button-outline !min-h-10 !px-4 !py-2 !text-[11px]" onPress={() => setMoveModalOpen(false)}>
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-blue !min-h-10 !px-4 !py-2 !text-[11px]"
              onPress={handleMoveRecords}
              isDisabled={!moveDialogTargetTableId}
              isLoading={bulkLoading}
            >
              确认移动
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      

      <Modal isOpen={deleteConfirmOpen} onClose={() => setDeleteConfirmOpen(false)} size="md">
        <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
          <ModalHeader className="border-b border-[var(--border)]">确认删除</ModalHeader>
          <ModalBody className="space-y-3 py-5">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              将删除选中的 {selectedIds.size} 条记录。
            </p>
            {!currentTableIsTotal && (
              <label className="bauhaus-panel-sm flex items-center gap-2 bg-white px-3 py-3 text-sm font-medium text-[var(--foreground-soft)]">
                <Checkbox
                  isSelected={deleteFromTotal}
                  onValueChange={setDeleteFromTotal}
                  radius="none"
                />
                同时从总表删除（高风险）
              </label>
            )}
            {currentTableIsTotal && (
              <div className="bauhaus-panel-sm bg-[var(--status-blush)] px-3 py-3 text-sm font-medium text-[var(--primary-red)]">
                当前是总表：删除将同步从所有子表移除。
              </div>
            )}
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border)]">
            <Button className="bauhaus-button bauhaus-button-outline !min-h-10 !px-4 !py-2 !text-[11px]" onPress={() => setDeleteConfirmOpen(false)}>
              取消
            </Button>
            <Button
              className="bauhaus-button bauhaus-button-red !min-h-10 !px-4 !py-2 !text-[11px]"
              onPress={handleDeleteRecords}
              isLoading={bulkLoading}
            >
              确认删除
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {editHintToastVisible && (
        <div className="feedback-pop fixed right-4 top-20 z-50 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--foreground-soft)]">
          编辑中：按 Esc 或点击空白处保存并退出
        </div>
      )}

      {cellSaving && (
        <div className="feedback-pop fixed right-4 top-4 z-50 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-medium text-[var(--foreground-soft)]">
          正在保存单元格...
        </div>
      )}
    </div>
  );
}

