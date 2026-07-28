"use client";

// =============================================
// 工作台共享状态:当前选中对象 / 右侧上下文栏模式 / 命令面板
// ADR 0031:对象详情与主 Agent 共用一个右侧上下文栏,
// 在"详情"和"OfferU"两种模式之间切换并共享当前选中对象。
// =============================================

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export type SelectionKind = "application" | "job" | "event" | "task" | "profile-fact";

export interface WorkbenchSelection {
  kind: SelectionKind;
  id: string | number;
  title: string;
  subtitle?: string;
  /** 检查器渲染所需的原始数据(记录、schema 等),按 kind 约定 */
  data?: Record<string, unknown>;
}

export type RailMode = "inspector" | "agent";

interface WorkbenchContextValue {
  selection: WorkbenchSelection | null;
  /** 选中对象并把右栏切到详情模式(渐进披露入口) */
  select: (next: WorkbenchSelection) => void;
  clearSelection: () => void;
  railMode: RailMode;
  setRailMode: (mode: RailMode) => void;
  railOpen: boolean;
  setRailOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function WorkbenchProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = useState<WorkbenchSelection | null>(null);
  const [railMode, setRailMode] = useState<RailMode>("agent");
  const [railOpen, setRailOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const select = useCallback((next: WorkbenchSelection) => {
    setSelection(next);
    setRailMode("inspector");
    setRailOpen(true);
  }, []);

  const clearSelection = useCallback(() => setSelection(null), []);

  const value = useMemo(
    () => ({
      selection,
      select,
      clearSelection,
      railMode,
      setRailMode,
      railOpen,
      setRailOpen,
      paletteOpen,
      setPaletteOpen,
    }),
    [selection, select, clearSelection, railMode, railOpen, paletteOpen]
  );

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench() {
  const context = useContext(WorkbenchContext);
  if (!context) {
    throw new Error("useWorkbench 必须在 WorkbenchProvider 内使用");
  }
  return context;
}

/** 页面不在外壳内(如打印页)时安全获取,返回 null 而不是抛错 */
export function useWorkbenchOptional() {
  return useContext(WorkbenchContext);
}
