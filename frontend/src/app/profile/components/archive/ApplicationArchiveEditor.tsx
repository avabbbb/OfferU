"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button, Card, CardBody, Input, Select, SelectItem, Textarea } from "@nextui-org/react";
import { ChevronDown, ChevronUp, Plus, RotateCcw, Save, Trash2, Upload } from "lucide-react";
import type {
  ApplicationArchive,
  ApplicationFamilyMemberItem,
  ArchiveAttachment,
  ResumeArchive,
} from "@/lib/personalArchive";
import {
  buildRegionValue,
  getAllCityNames,
  getCityOptions,
  getDistrictOptions,
  getProvinceOptions,
  parseRegionSelection,
} from "@/lib/chinaRegion";

interface ApplicationArchiveEditorProps {
  value: ApplicationArchive;
  resumeArchive: ResumeArchive;
  overriddenPaths: string[];
  focusSection?: string;
  missingSections?: string[];
  saving?: boolean;
  onChange: (next: ApplicationArchive) => void;
  onToggleOverride: (path: string, enabled: boolean) => void;
  onRequestEditSharedModule?: (path: string) => void;
  onSaveItem?: () => void | Promise<void>;
}

function cloneApp(value: ApplicationArchive): ApplicationArchive {
  return JSON.parse(JSON.stringify(value)) as ApplicationArchive;
}

function normalizeFocusSectionKey(focusSection: string | undefined): string | undefined {
  if (!focusSection) return undefined;
  if (focusSection.startsWith("shared")) return "shared";
  return focusSection;
}

function collapsedOrDefault(value: boolean | undefined): boolean {
  return value ?? false;
}

function useSectionState(focusSection: string | undefined) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const focusKey = normalizeFocusSectionKey(focusSection);

  useEffect(() => {
    if (!focusKey) return;
    setCollapsed((prev) => ({ ...prev, [focusKey]: false }));
  }, [focusKey]);

  return {
    isCollapsed: (key: string) => collapsedOrDefault(collapsed[key]),
    toggle: (key: string) =>
      setCollapsed((prev) => ({
        ...prev,
        [key]: !collapsedOrDefault(prev[key]),
      })),
  };
}

const fieldClassNames = {
  inputWrapper: "border border-[var(--border-strong)]/15 bg-[var(--surface)] shadow-[1px_1px_0_0_rgba(18,18,18,0.08)] group-data-[focus=true]:border-[var(--border-strong)]/35",
  input: "text-sm text-[var(--foreground)]",
  label: "text-xs font-semibold text-[var(--foreground-muted)]",
};

const selectClassNames = {
  trigger: "h-10 border border-[var(--border-strong)]/15 bg-[var(--surface)] shadow-[1px_1px_0_0_rgba(18,18,18,0.08)] data-[hover=true]:border-[var(--border-strong)]/35",
  value: "text-sm text-[var(--foreground)]",
  label: "text-xs font-semibold text-[var(--foreground-muted)]",
  popoverContent: "border border-[var(--border-strong)]/15 bg-[var(--surface)] text-[var(--foreground)] shadow-[2px_2px_0_0_rgba(18,18,18,0.12)]",
  listboxWrapper: "bg-[var(--surface)] p-1",
};

const ETHNICITY_OPTIONS = [
  "汉族",
  "蒙古族",
  "回族",
  "藏族",
  "维吾尔族",
  "苗族",
  "彝族",
  "壮族",
  "布依族",
  "朝鲜族",
  "满族",
  "侗族",
  "瑶族",
  "白族",
  "土家族",
  "哈尼族",
  "哈萨克族",
  "傣族",
  "黎族",
  "傈僳族",
  "佤族",
  "畲族",
  "高山族",
  "拉祜族",
  "水族",
  "东乡族",
  "纳西族",
  "景颇族",
  "柯尔克孜族",
  "土族",
  "达斡尔族",
  "仫佬族",
  "羌族",
  "布朗族",
  "撒拉族",
  "毛南族",
  "仡佬族",
  "锡伯族",
  "阿昌族",
  "普米族",
  "塔吉克族",
  "怒族",
  "乌孜别克族",
  "俄罗斯族",
  "鄂温克族",
  "德昂族",
  "保安族",
  "裕固族",
  "京族",
  "塔塔尔族",
  "独龙族",
  "鄂伦春族",
  "赫哲族",
  "门巴族",
  "珞巴族",
  "基诺族",
];

function encodeDatePreference(date: string): string {
  return date ? `DATE:${date}` : "具体日期";
}

function decodeDatePreference(value: string): string {
  if (!value.startsWith("DATE:")) return "";
  return value.slice(5);
}

function SelectField(props: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (next: string) => void;
  isDisabled?: boolean;
  isInvalid?: boolean;
  errorMessage?: string;
}) {
  const selectedKeys = props.value ? new Set([props.value]) : new Set<string>();
  return (
    <Select
      label={props.label}
      size="sm"
      variant="bordered"
      selectedKeys={selectedKeys}
      classNames={selectClassNames}
      isDisabled={props.isDisabled}
      isInvalid={props.isInvalid}
      errorMessage={props.errorMessage}
      onSelectionChange={(keys) => {
        const selected = Array.from(keys)[0];
        props.onChange(selected ? String(selected) : "");
      }}
    >
      {props.options.map((option) => (
        <SelectItem key={option.value} textValue={option.label}>
          {option.label}
        </SelectItem>
      ))}
    </Select>
  );
}

function MultiSelectField(props: {
  label: string;
  values: string[];
  options: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <Select
      label={props.label}
      size="sm"
      variant="bordered"
      selectionMode="multiple"
      selectedKeys={new Set(props.values)}
      classNames={selectClassNames}
      onSelectionChange={(keys) => props.onChange(Array.from(keys).map((item) => String(item)))}
    >
      {props.options.map((option) => (
        <SelectItem key={option} textValue={option}>
          {option}
        </SelectItem>
      ))}
    </Select>
  );
}

function DatePickerField(props: {
  label: string;
  value: string;
  mode?: "date" | "month";
  onChange: (next: string) => void;
}) {
  const includeDay = props.mode !== "month";
  const splitDateParts = (raw: string) => {
    const normalized = String(raw || "").trim();
    const [year = "", month = "", day = ""] = normalized.split("-");
    return {
      year: year.replace(/\D/g, "").slice(0, 4),
      month: month.replace(/\D/g, "").slice(0, 2),
      day: includeDay ? day.replace(/\D/g, "").slice(0, 2) : "",
    };
  };
  const daysInMonth = (year: string, month: string): number => {
    if (!year || !month) return 31;
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 31;
    return new Date(y, m, 0).getDate();
  };
  const toDateText = (parts: { year: string; month: string; day: string }) => {
    const y = parts.year;
    const m = parts.month;
    const d = parts.day;
    if (!y && !m && !d) return "";
    if (!y || !m) return [y, m].filter(Boolean).join("-");
    const mm = m.padStart(2, "0");
    if (!includeDay || !d) return `${y}-${mm}`;
    return `${y}-${mm}-${d.padStart(2, "0")}`;
  };
  const parts = splitDateParts(props.value);
  const currentYear = new Date().getFullYear();
  const minYear = 1950;
  const maxYear = currentYear + 10;
  const yearOptions: Array<{ value: string; label: string }> = [];
  for (let year = maxYear; year >= minYear; year -= 1) {
    const v = String(year);
    yearOptions.push({ value: v, label: v });
  }
  if (parts.year && !yearOptions.some((item) => item.value === parts.year)) {
    yearOptions.unshift({ value: parts.year, label: parts.year });
  }
  const monthOptions = Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    return { value: month, label: month };
  });
  const dayMax = daysInMonth(parts.year, parts.month);
  const dayOptions = Array.from({ length: dayMax }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    return { value: day, label: day };
  });
  const updatePart = (part: "year" | "month" | "day", valueText: string) => {
    const current = splitDateParts(props.value);
    const next = { ...current, [part]: valueText };
    if (!next.year) {
      next.month = "";
      next.day = "";
    }
    if (!next.month) {
      next.day = "";
    }
    if (!includeDay) {
      next.day = "";
    }
    const maxDay = daysInMonth(next.year, next.month);
    if (next.day && Number(next.day) > maxDay) {
      next.day = "";
    }
    props.onChange(toDateText(next));
  };
  return (
    <div className={`grid ${includeDay ? "grid-cols-3" : "grid-cols-2"} gap-2`}>
      <SelectField
        label={`${props.label}/年`}
        value={parts.year}
        options={yearOptions}
        onChange={(next) => updatePart("year", next)}
      />
      <SelectField
        label={`${props.label}/月`}
        value={parts.month}
        options={monthOptions}
        isDisabled={!parts.year}
        onChange={(next) => updatePart("month", next)}
      />
      {includeDay ? (
        <SelectField
          label={`${props.label}/日`}
          value={parts.day}
          options={dayOptions}
          isDisabled={!parts.year || !parts.month}
          onChange={(next) => updatePart("day", next)}
        />
      ) : null}
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  isInvalid?: boolean;
  errorMessage?: string;
}) {
  return (
    <Input
      label={props.label}
      value={props.value}
      variant="bordered"
      size="sm"
      classNames={fieldClassNames}
      isInvalid={props.isInvalid}
      errorMessage={props.errorMessage}
      onValueChange={props.onChange}
    />
  );
}

function RegionSelectField(props: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const selection = useMemo(() => parseRegionSelection(props.value), [props.value]);
  const provinceOptions = useMemo(
    () => getProvinceOptions().map((item) => ({ value: item.code, label: item.label })),
    []
  );
  const cityOptions = useMemo(
    () => getCityOptions(selection.provinceCode).map((item) => ({ value: item.code, label: item.label })),
    [selection.provinceCode]
  );
  const effectiveCityCode = selection.cityCode || (cityOptions.length === 1 ? cityOptions[0].value : "");
  const districtOptions = useMemo(
    () => getDistrictOptions(effectiveCityCode).map((item) => ({ value: item.code, label: item.label })),
    [effectiveCityCode]
  );

  return (
    <div className="grid grid-cols-3 gap-2">
      <SelectField
        label={`${props.label}/省`}
        value={selection.provinceCode}
        options={provinceOptions}
        onChange={(nextProvinceCode) => props.onChange(buildRegionValue(nextProvinceCode))}
      />
      <SelectField
        label={`${props.label}/市`}
        value={effectiveCityCode}
        options={cityOptions}
        isDisabled={!selection.provinceCode || cityOptions.length === 0}
        onChange={(nextCityCode) =>
          props.onChange(buildRegionValue(selection.provinceCode, nextCityCode))
        }
      />
      <SelectField
        label={`${props.label}/区`}
        value={selection.districtCode}
        options={districtOptions}
        isDisabled={!selection.provinceCode || !effectiveCityCode || districtOptions.length === 0}
        onChange={(nextDistrictCode) =>
          props.onChange(buildRegionValue(selection.provinceCode, effectiveCityCode, nextDistrictCode))
        }
      />
    </div>
  );
}

function EthnicitySelectField(props: { value: string; onChange: (next: string) => void }) {
  return (
    <SelectField
      label="民族"
      value={props.value}
      options={ETHNICITY_OPTIONS.map((item) => ({ value: item, label: item }))}
      onChange={props.onChange}
    />
  );
}

function NationalitySelectField(props: { value: string; onChange: (next: string) => void }) {
  return (
    <SelectField
      label="国籍/地区"
      value={props.value}
      options={[
        { value: "中国大陆", label: "中国大陆" },
        { value: "中国香港", label: "中国香港" },
        { value: "中国澳门", label: "中国澳门" },
        { value: "中国台湾", label: "中国台湾" },
        { value: "其他", label: "其他" },
      ]}
      onChange={props.onChange}
    />
  );
}

function SectionFrame(props: {
  sectionKey: string;
  title: string;
  description: string;
  focused?: boolean;
  missing?: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  children: ReactNode;
}) {
  const borderClass = props.missing
    ? "border-[var(--primary-red)] shadow-[0_0_0_1px_rgba(201,85,72,0.22)]"
    : props.focused
      ? "ring-2 ring-[color:color-mix(in_srgb,var(--auxiliary-blue)_45%,#ffffff_55%)]"
      : "";
  const titleClass = props.missing ? "text-[var(--primary-red)]" : "text-[var(--foreground)]";
  const descClass = props.missing ? "text-[color:color-mix(in_srgb,var(--primary-red)_80%,#3a2f2a_20%)]" : "text-[var(--foreground-muted)]";

  return (
    <Card className={`bauhaus-panel overflow-hidden bg-[var(--surface)] ${borderClass}`} data-section={props.sectionKey}>
      <CardBody className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className={`text-lg font-semibold ${titleClass}`}>{props.title}</div>
            <div className={`text-sm ${descClass}`}>{props.description}</div>
          </div>
          <div className="flex items-center gap-2">
            {props.missing && (
              <span className="bauhaus-chip border-[var(--primary-red)] bg-[color:color-mix(in_srgb,var(--primary-red)_10%,#ffffff_90%)] text-[var(--primary-red)]">
                待补齐             </span>
            )}
            <Button
              size="sm"
              className="bauhaus-button bauhaus-button-outline !h-8 !px-3 !py-2 !text-[11px]"
              onPress={props.onToggleCollapse}
            >
              {props.collapsed ? "展开" : "折叠"}
            </Button>
          </div>
        </div>
        {!props.collapsed && props.children}
      </CardBody>
    </Card>
  );
}

function OverrideBadge(props: { overridden: boolean }) {
  return (
    <span
      className={`bauhaus-chip ${props.overridden ? "bg-[color:color-mix(in_srgb,var(--primary-red)_9%,#ffffff_91%)] text-[var(--primary-red)]" : "bg-[var(--surface-muted)] text-[var(--foreground-muted)]"}`}
    >
      {props.overridden ? "投递侧已覆盖" : "跟随简历档案"}
    </span>
  );
}

function AttachmentField(props: {
  label: string;
  fieldType: string;
  value: ArchiveAttachment | null;
  onChange: (next: ArchiveAttachment | null) => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const inputId = useId();
  const formatSize = (size: number) => {
    if (!size) return "未知大小";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="bauhaus-panel-sm space-y-2 p-3">
      <div className="text-sm font-semibold text-[var(--foreground)]">{props.label}</div>
      {props.value ? (
        <div className="space-y-1 text-xs text-[var(--foreground-muted)]">
          <div className="font-medium text-[var(--foreground)]">{props.value.fileName}</div>
          <div>
            {props.value.fileType || "未知类型"}  · {formatSize(props.value.fileSize)}
          </div>
          <div>上传时间：{new Date(props.value.uploadedAt).toLocaleString()}</div>
        </div>
      ) : (
        <div className="text-xs text-[var(--foreground-muted)]">尚未上传文件</div>
      )}

      <div className="flex flex-wrap gap-2">
        <label htmlFor={inputId} className="cursor-pointer">
          <span className="inline-flex">
            <Button
              size="sm"
              startContent={<Upload size={13} />}
              className="bauhaus-button bauhaus-button-outline !h-8 !px-3 !py-2 !text-[11px]"
              as="span"
            >
              {props.value ? "重新上传" : "上传文件"}
            </Button>
          </span>
        </label>
        <input
          id={inputId}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            props.onChange({
              id: `att_${Math.random().toString(36).slice(2, 10)}`,
              fileName: file.name,
              fileType: file.type || "",
              fileSize: file.size,
              uploadedAt: new Date().toISOString(),
              fieldType: props.fieldType,
            });
            event.target.value = "";
          }}
        />
        <Button
          size="sm"
          className="bauhaus-button bauhaus-button-red !h-8 !px-3 !py-2 !text-[11px]"
          isDisabled={!props.value}
          onPress={() => props.onChange(null)}
        >
          删除
        </Button>
        <Button
          size="sm"
          startContent={<Save size={13} />}
          className="bauhaus-button bauhaus-button-blue !h-8 !px-3 !py-2 !text-[11px]"
          onPress={props.onSave} isLoading={props.saving} isDisabled={props.saving}
        >
          {props.saving ? "保存中..." : "保存"}
        </Button>
      </div>
    </div>
  );
}

function FamilyMemberItem(props: {
  value: ApplicationFamilyMemberItem;
  onChange: (next: ApplicationFamilyMemberItem) => void;
  onDelete: () => void;
  onSave?: () => void;
  saving?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bauhaus-panel-sm space-y-3 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 text-base font-semibold text-[var(--foreground)]">
          <span className="line-clamp-1 break-words">{props.value.name || "未命名家庭成员"}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            startContent={<Save size={13} />}
            className="bauhaus-button bauhaus-button-blue !h-8 !px-3 !py-2 !text-[11px]"
            onPress={props.onSave} isLoading={props.saving} isDisabled={props.saving}
          >
            {props.saving ? "保存中..." : "保存"}
          </Button>
          <Button
            size="sm"
            className="bauhaus-button bauhaus-button-outline !h-8 !px-3 !py-2 !text-[11px]"
            onPress={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? (
              <span className="inline-flex items-center gap-1"><ChevronDown size={13} />展开</span>
            ) : (
              <span className="inline-flex items-center gap-1"><ChevronUp size={13} />折叠</span>
            )}
          </Button>
          <Button
            size="sm"
            startContent={<Trash2 size={14} />}
            className="bauhaus-button bauhaus-button-red !h-8 !px-3 !py-2 !text-[11px] text-white"
            onPress={props.onDelete}
          >
            删除
          </Button>
        </div>
      </div>
      {!collapsed && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <TextField label="姓名" value={props.value.name} onChange={(v) => props.onChange({ ...props.value, name: v })} />
          <SelectField
            label="关系"
            value={props.value.relation}
            options={[
              { value: "父亲", label: "父亲" },
              { value: "母亲", label: "母亲" },
              { value: "配偶", label: "配偶" },
              { value: "子女", label: "子女" },
              { value: "兄弟姐妹", label: "兄弟姐妹" },
              { value: "其他", label: "其他" },
            ]}
            onChange={(next) => props.onChange({ ...props.value, relation: next })}
          />
          <TextField label="工作单位" value={props.value.company} onChange={(v) => props.onChange({ ...props.value, company: v })} />
          <TextField label="职务" value={props.value.position} onChange={(v) => props.onChange({ ...props.value, position: v })} />
          <TextField label="联系方式" value={props.value.contact} onChange={(v) => props.onChange({ ...props.value, contact: v })} />
        </div>
      )}
    </div>
  );
}

const sharedModuleConfigs = [
  { path: "education", label: "教育经历" },
  { path: "workExperiences", label: "工作经历" },
  { path: "internshipExperiences", label: "实习经历" },
  { path: "projects", label: "项目经历" },
  { path: "skills", label: "技能条目" },
  { path: "certificates", label: "证书条目" },
  { path: "awards", label: "获奖经历" },
  { path: "personalExperiences", label: "个人经历" },
] as const;

const yesNoOptions = [
  { value: "是", label: "是" },
  { value: "否", label: "否" },
];

export default function ApplicationArchiveEditor(props: ApplicationArchiveEditorProps) {
  const { value, resumeArchive } = props;
  const [moduleDrafts, setModuleDrafts] = useState<Record<string, string>>({});
  const sectionState = useSectionState(props.focusSection);
  const missingSet = useMemo(() => new Set(props.missingSections || []), [props.missingSections]);
  const allCityOptions = useMemo(() => getAllCityNames(), []);

  useEffect(() => {
    const nextDrafts: Record<string, string> = {};
    for (const config of sharedModuleConfigs) {
      nextDrafts[config.path] = JSON.stringify((value.shared as Record<string, any>)[config.path] ?? [], null, 2);
    }
    setModuleDrafts(nextDrafts);
  }, [value.shared]);

  const overriddenSet = useMemo(() => new Set(props.overriddenPaths), [props.overriddenPaths]);

  const update = (mutator: (draft: ApplicationArchive) => void) => {
    const next = cloneApp(value);
    mutator(next);
    props.onChange(next);
  };

  const isOverridden = (path: string) => overriddenSet.has(path);
  const saveItem = () => {
    if (props.saving) return;
    void props.onSaveItem?.();
  };

  const sharedField = (
    label: string,
    path: string,
    valueText: string,
    onValueChange: (next: string) => void
  ) => {
    const overridden = isOverridden(path);
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-[var(--foreground-muted)]">{label}</span>
          <OverrideBadge overridden={overridden} />
        </div>
        <Input
          value={valueText}
          size="sm"
          variant="bordered"
          classNames={fieldClassNames}
          onValueChange={(nextValue) => {
            props.onToggleOverride(path, true);
            onValueChange(nextValue);
          }}
        />
        {overridden && (
          <div className="space-y-2">
            <p className="text-xs text-[var(--primary-red)]">该字段已在投递档案中单独修改，后续不会被简历档案自动覆盖。</p>
            <Button
              size="sm"
              variant="light"
              startContent={<RotateCcw size={14} />}
              className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
              onPress={() => props.onToggleOverride(path, false)}
            >
              恢复跟随简历档案       </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <SectionFrame
        sectionKey="shared"
        title="共享模块与简历继承" description="继承简历档案内容，支持跳转到对应模块编辑。" focused={normalizeFocusSectionKey(props.focusSection) === "shared"}
        missing={false}
        collapsed={sectionState.isCollapsed("shared")}
        onToggleCollapse={() => sectionState.toggle("shared")}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {sharedField("姓名", "basicInfo.name", value.shared.basicInfo.name, (next) => update((draft) => { draft.shared.basicInfo.name = next; }))}
          {sharedField("手机号", "basicInfo.phone", value.shared.basicInfo.phone, (next) => update((draft) => { draft.shared.basicInfo.phone = next; }))}
          {sharedField("邮箱", "basicInfo.email", value.shared.basicInfo.email, (next) => update((draft) => { draft.shared.basicInfo.email = next; }))}
          {sharedField("当前城市", "basicInfo.currentCity", value.shared.basicInfo.currentCity, (next) => update((draft) => { draft.shared.basicInfo.currentCity = next; }))}
          {sharedField("求职意向", "basicInfo.jobIntention", value.shared.basicInfo.jobIntention, (next) => update((draft) => { draft.shared.basicInfo.jobIntention = next; }))}
          {sharedField("个人网站", "basicInfo.website", value.shared.basicInfo.website, (next) => update((draft) => { draft.shared.basicInfo.website = next; }))}
          {sharedField("GitHub", "basicInfo.github", value.shared.basicInfo.github, (next) => update((draft) => { draft.shared.basicInfo.github = next; }))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-[var(--foreground-muted)]">个人简介</span>
            <OverrideBadge overridden={isOverridden("personalSummary")} />
          </div>
          <Textarea
            minRows={3}
            size="sm"
            variant="bordered"
            classNames={fieldClassNames}
            value={value.shared.personalSummary}
            onValueChange={(next) => {
              props.onToggleOverride("personalSummary", true);
              update((draft) => {
                draft.shared.personalSummary = next;
              });
            }}
          />
          {isOverridden("personalSummary") && (
            <div className="space-y-2">
              <p className="text-xs text-[var(--primary-red)]">该字段已在投递档案中单独修改，后续不会被简历档案自动覆盖。</p>
              <Button
                size="sm"
                variant="light"
                startContent={<RotateCcw size={14} />}
                className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
                onPress={() => props.onToggleOverride("personalSummary", false)}
              >
              恢复跟随简历档案       </Button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {sharedModuleConfigs.map((config) => {
            const overridden = isOverridden(config.path);
            const moduleValue = (value.shared as Record<string, any>)[config.path];
            return (
              <div key={config.path} className="bauhaus-panel-sm space-y-2 bg-[var(--surface)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-[var(--foreground)]">
                    {config.label}（{Array.isArray(moduleValue) ? moduleValue.length : 0} 条）
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <OverrideBadge overridden={overridden} />
                    <Button
                      size="sm"
                      className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
                      onPress={() => props.onRequestEditSharedModule?.(config.path)}
                    >
                      修改该模块                    </Button>
                    {overridden && (
                      <Button
                        size="sm"
                        startContent={<RotateCcw size={14} />}
                        className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
                        onPress={() => props.onToggleOverride(config.path, false)}
                      >
              恢复跟随简历档案       </Button>
                    )}
                  </div>
                </div>
                {overridden && (
                  <>
                    <p className="text-xs text-[var(--primary-red)]">该字段已在投递档案中单独修改，后续不会被简历档案自动覆盖。</p>
                    <Textarea
                      minRows={4}
                      size="sm"
                      variant="bordered"
                      classNames={fieldClassNames}
                      value={moduleDrafts[config.path] || "[]"}
                      onValueChange={(nextText) => {
                        setModuleDrafts((prev) => ({ ...prev, [config.path]: nextText }));
                        try {
                          const parsed = JSON.parse(nextText);
                          if (!Array.isArray(parsed)) return;
                          update((draft) => {
                            (draft.shared as Record<string, any>)[config.path] = parsed;
                          });
                        } catch {
                          // keep draft text until valid JSON
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      startContent={<Save size={13} />}
                      className="bauhaus-button bauhaus-button-blue !h-8 !px-3 !py-2 !text-[11px]"
                      onPress={saveItem} isLoading={props.saving} isDisabled={props.saving}
                    >
                      {props.saving ? "保存中..." : "保存模块覆盖"}
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </SectionFrame>

      <SectionFrame
        sectionKey="identityContact"
        title="身份与联系方式" description="投递常用实名和身份字段。" focused={normalizeFocusSectionKey(props.focusSection) === "identityContact"}
        missing={missingSet.has("identityContact")}
        collapsed={sectionState.isCollapsed("identityContact")}
        onToggleCollapse={() => sectionState.toggle("identityContact")}
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <TextField
            label="中文姓名"
            value={value.identityContact.chineseName}
            isInvalid={missingSet.has("identityContact") && !value.identityContact.chineseName.trim()}
            errorMessage={missingSet.has("identityContact") && !value.identityContact.chineseName.trim() ? "请补充中文姓否" : undefined}
            onChange={(v) => update((draft) => { draft.identityContact.chineseName = v; })}
          />
          <TextField label="英文否拼音否" value={value.identityContact.englishOrPinyinName} onChange={(v) => update((draft) => { draft.identityContact.englishOrPinyinName = v; })} />
          <TextField
            label="手机号" value={value.identityContact.phone}
            isInvalid={missingSet.has("identityContact") && !value.identityContact.phone.trim()}
            errorMessage={missingSet.has("identityContact") && !value.identityContact.phone.trim() ? "请补充手机号" : undefined}
            onChange={(v) => update((draft) => { draft.identityContact.phone = v; })}
          />
          <TextField label="邮箱" value={value.identityContact.email} onChange={(v) => update((draft) => { draft.identityContact.email = v; })} />
          <SelectField
            label="性别"
            value={value.identityContact.gender}
            options={[
              { value: "男", label: "男" },
              { value: "女", label: "女" },
              { value: "其他/不便透露", label: "其他/不便透露" },
            ]}
            onChange={(next) => update((draft) => { draft.identityContact.gender = next; })}
          />
          <DatePickerField
            label="出生日期"
            value={value.identityContact.birthDate}
            mode="date"
            onChange={(next) => update((draft) => { draft.identityContact.birthDate = next; })}
          />
          <NationalitySelectField value={value.identityContact.nationalityOrRegion} onChange={(next) => update((draft) => { draft.identityContact.nationalityOrRegion = next; })} />
          <SelectField
            label="证件类型"
            value={value.identityContact.idType}
            options={[
              { value: "身份证", label: "身份证" },
              { value: "护照", label: "护照" },
              { value: "港澳通行证", label: "港澳通行证" },
              { value: "台胞证", label: "台胞证" },
              { value: "其他", label: "其他" },
            ]}
            onChange={(next) => update((draft) => { draft.identityContact.idType = next; })}
          />
          <TextField label="证件号码" value={value.identityContact.idNumber} onChange={(v) => update((draft) => { draft.identityContact.idNumber = v; })} />
          <RegionSelectField label="当前城市" value={value.identityContact.currentCity} onChange={(v) => update((draft) => { draft.identityContact.currentCity = v; })} />
          <TextField label="现居地址" value={value.identityContact.currentAddress} onChange={(v) => update((draft) => { draft.identityContact.currentAddress = v; })} />
          <RegionSelectField label="籍贯" value={value.identityContact.nativePlace} onChange={(v) => update((draft) => { draft.identityContact.nativePlace = v; })} />
          <RegionSelectField label="户籍地址" value={value.identityContact.householdRegistration} onChange={(v) => update((draft) => { draft.identityContact.householdRegistration = v; })} />
          <EthnicitySelectField value={value.identityContact.ethnicity} onChange={(v) => update((draft) => { draft.identityContact.ethnicity = v; })} />
          <SelectField
            label="政治面貌"
            value={value.identityContact.politicalStatus}
            options={[
              { value: "群众", label: "群众" },
              { value: "共青团员", label: "共青团员" },
              { value: "中共党员", label: "中共党员" },
              { value: "中共预备党员", label: "中共预备党员" },
              { value: "民主党派", label: "民主党派" },
              { value: "无党派人士", label: "无党派人士" },
              { value: "其他", label: "其他" },
            ]}
            onChange={(next) => update((draft) => { draft.identityContact.politicalStatus = next; })}
          />
          <SelectField
            label="婚姻状态" value={value.identityContact.maritalStatus}
            options={[
              { value: "未婚", label: "未婚" },
              { value: "已婚", label: "已婚" },
            ]}
            onChange={(next) => update((draft) => { draft.identityContact.maritalStatus = next; })}
          />
        </div>
        <Button
          size="sm"
          startContent={<Save size={13} />}
          className="bauhaus-button bauhaus-button-blue !h-8 !px-3 !py-2 !text-[11px]"
          onPress={saveItem} isLoading={props.saving} isDisabled={props.saving}
        >
          {props.saving ? "保存中..." : "保存本模块"}</Button>
      </SectionFrame>

      <SectionFrame
        sectionKey="jobPreference"
        title="求职偏好"
        description="尽量使用枚举/布尔字段。" focused={normalizeFocusSectionKey(props.focusSection) === "jobPreference"}
        missing={missingSet.has("jobPreference")}
        collapsed={sectionState.isCollapsed("jobPreference")}
        onToggleCollapse={() => sectionState.toggle("jobPreference")}
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <TextField
            label="期望岗位"
            value={value.jobPreference.expectedPosition}
            isInvalid={missingSet.has("jobPreference") && !value.jobPreference.expectedPosition.trim()}
            errorMessage={missingSet.has("jobPreference") && !value.jobPreference.expectedPosition.trim() ? "请补充期望岗位" : undefined}
            onChange={(v) => update((draft) => { draft.jobPreference.expectedPosition = v; })}
          />
          <TextField label="期望岗位类别" value={value.jobPreference.expectedPositionCategory} onChange={(v) => update((draft) => { draft.jobPreference.expectedPositionCategory = v; })} />
          <MultiSelectField
            label="期望城市"
            values={value.jobPreference.expectedCities}
            options={allCityOptions}
            onChange={(next) => update((draft) => { draft.jobPreference.expectedCities = next; })}
          />
          <TextField label="期望薪资" value={value.jobPreference.expectedSalary} onChange={(v) => update((draft) => { draft.jobPreference.expectedSalary = v; })} />
          <SelectField
            label="工作性质"
            value={value.jobPreference.employmentType}
            options={[
              { value: "全职", label: "全职" },
              { value: "实习", label: "实习" },
              { value: "校招", label: "校招" },
              { value: "社招", label: "社招" },
              { value: "兼职", label: "兼职" },
            ]}
            onChange={(next) => update((draft) => { draft.jobPreference.employmentType = next; })}
          />
          <SelectField
            label="到岗时间"
            value={value.jobPreference.availableStartDate.startsWith("DATE:") ? "具体日期" : value.jobPreference.availableStartDate}
            options={[
              { value: "随时", label: "随时" },
              { value: "一周内", label: "一周内" },
              { value: "一个月内", label: "一个月内" },
              { value: "三个月内", label: "三个月内" },
              { value: "具体日期", label: "具体日期" },
            ]}
            onChange={(next) =>
              update((draft) => {
                draft.jobPreference.availableStartDate = next === "具体日期" ? encodeDatePreference(new Date().toISOString().slice(0, 10)) : next;
              })
            }
          />
          {value.jobPreference.availableStartDate.startsWith("DATE:") && (
            <DatePickerField
              label="到岗具体日期"
              value={decodeDatePreference(value.jobPreference.availableStartDate)}
              mode="date"
              onChange={(next) => update((draft) => { draft.jobPreference.availableStartDate = encodeDatePreference(next); })}
            />
          )}
          <SelectField
            label="当前求职状态" value={value.jobPreference.currentJobSearchStatus}
            options={[
              { value: "在职", label: "在职" },
              { value: "离职", label: "离职" },
              { value: "应届", label: "应届" },
              { value: "实习中", label: "实习中" },
              { value: "在读", label: "在读" },
            ]}
            onChange={(next) => update((draft) => { draft.jobPreference.currentJobSearchStatus = next; })}
          />
          <SelectField label="是否接受调剂" value={value.jobPreference.acceptAdjustment} options={yesNoOptions} onChange={(next) => update((draft) => { draft.jobPreference.acceptAdjustment = next; })} />
          <SelectField label="是否接受出差" value={value.jobPreference.acceptBusinessTravel} options={yesNoOptions} onChange={(next) => update((draft) => { draft.jobPreference.acceptBusinessTravel = next; })} />
          <SelectField label="是否接受外派" value={value.jobPreference.acceptAssignment} options={yesNoOptions} onChange={(next) => update((draft) => { draft.jobPreference.acceptAssignment = next; })} />
          <SelectField label="是否接受倒班/轮班" value={value.jobPreference.acceptShiftWork} options={yesNoOptions} onChange={(next) => update((draft) => { draft.jobPreference.acceptShiftWork = next; })} />
        </div>
        <Button size="sm" startContent={<Save size={13} />} className="bauhaus-button bauhaus-button-blue !h-8 !px-3 !py-2 !text-[11px]" onPress={saveItem} isLoading={props.saving} isDisabled={props.saving}>
          {props.saving ? "保存中..." : "保存本模块"}</Button>
      </SectionFrame>

      <SectionFrame
        sectionKey="campusFields"
        title="校招专项"
        description="语言成绩可从技能与证书复用。" focused={normalizeFocusSectionKey(props.focusSection) === "campusFields"}
        missing={missingSet.has("campusFields")}
        collapsed={sectionState.isCollapsed("campusFields")}
        onToggleCollapse={() => sectionState.toggle("campusFields")}
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <SelectField label="是否应届" value={value.campusFields.isFreshGraduate} options={yesNoOptions} onChange={(next) => update((draft) => { draft.campusFields.isFreshGraduate = next; })} />
          <DatePickerField label="毕业时间" value={value.campusFields.graduationDate} mode="month" onChange={(v) => update((draft) => { draft.campusFields.graduationDate = v; })} />
          <RegionSelectField label="生源地" value={value.campusFields.studentOrigin} onChange={(v) => update((draft) => { draft.campusFields.studentOrigin = v; })} />
          <SelectField
            label="学籍状态" value={value.campusFields.studentStatus}
            options={[
              { value: "在读", label: "在读" },
              { value: "已毕业", label: "已毕业" },
              { value: "延期毕业", label: "延期毕业" },
              { value: "休学", label: "休学" },
              { value: "其他", label: "其他" },
            ]}
            onChange={(next) => update((draft) => { draft.campusFields.studentStatus = next; })}
          />
          <TextField label="学号" value={value.campusFields.studentId} onChange={(v) => update((draft) => { draft.campusFields.studentId = v; })} />
          <TextField label="GPA" value={value.campusFields.gpa} onChange={(v) => update((draft) => { draft.campusFields.gpa = v; })} />
          <TextField label="专业排名" value={value.campusFields.majorRank} onChange={(v) => update((draft) => { draft.campusFields.majorRank = v; })} />
          <TextField label="论文（文档/链接）" value={value.campusFields.thesis} onChange={(v) => update((draft) => { draft.campusFields.thesis = v; })} />
          <TextField label="专利（文档/链接）" value={value.campusFields.patent} onChange={(v) => update((draft) => { draft.campusFields.patent = v; })} />
        </div>
        <Textarea
          label="科研经历（多条，换行分隔）" minRows={3}
          size="sm"
          classNames={fieldClassNames}
          value={value.campusFields.researchExperiences.join("\n")}
          onValueChange={(v) => update((draft) => { draft.campusFields.researchExperiences = v.split(/\n+/).map((x) => x.trim()).filter(Boolean); })}
          variant="bordered"
        />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <AttachmentField
            label="成绩单（附件引用）" fieldType="campus.transcriptRef"
            value={value.campusFields.transcriptRef}
            onChange={(next) => update((draft) => { draft.campusFields.transcriptRef = next; })}
            onSave={saveItem} saving={props.saving}
          />
          <AttachmentField
            label="实习证明（附件引用）"
            fieldType="campus.internshipCertificateRef"
            value={value.campusFields.internshipCertificateRef}
            onChange={(next) => update((draft) => { draft.campusFields.internshipCertificateRef = next; })}
            onSave={saveItem} saving={props.saving}
          />
        </div>
      </SectionFrame>

      <SectionFrame
        sectionKey="relationshipCompliance"
        title="关系与合规信息" description="家庭成员、亲属关系、背调与竞业。" focused={normalizeFocusSectionKey(props.focusSection) === "relationshipCompliance"}
        missing={missingSet.has("relationshipCompliance")}
        collapsed={sectionState.isCollapsed("relationshipCompliance")}
        onToggleCollapse={() => sectionState.toggle("relationshipCompliance")}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-[var(--foreground)]">家庭成员</div>
            <Button
              size="sm"
              startContent={<Plus size={14} />}
              className="bauhaus-button bauhaus-button-outline !px-3 !py-2 !text-[11px]"
              onPress={() =>
                update((draft) => {
                  draft.relationshipCompliance.familyMembers.push({
                    id: `family_${Math.random().toString(36).slice(2, 10)}`,
                    name: "",
                    relation: "",
                    company: "",
                    position: "",
                    contact: "",
                  });
                })
              }
            >
              新增家庭成员
            </Button>
          </div>
          {value.relationshipCompliance.familyMembers.map((member, index) => (
            <FamilyMemberItem
              key={member.id}
              value={member}
              onSave={saveItem} saving={props.saving}
              onChange={(next) =>
                update((draft) => {
                  draft.relationshipCompliance.familyMembers[index] = next;
                })
              }
              onDelete={() =>
                update((draft) => {
                  draft.relationshipCompliance.familyMembers.splice(index, 1);
                })
              }
            />
          ))}
        </div>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <SelectField label="是否有亲属在目标公司任职" value={value.relationshipCompliance.hasRelativeInTargetCompany} options={yesNoOptions} onChange={(next) => update((draft) => { draft.relationshipCompliance.hasRelativeInTargetCompany = next; })} />
          <TextField label="亲属关系" value={value.relationshipCompliance.relativeRelation} onChange={(v) => update((draft) => { draft.relationshipCompliance.relativeRelation = v; })} />
          <TextField label="亲属姓名" value={value.relationshipCompliance.relativeName} onChange={(v) => update((draft) => { draft.relationshipCompliance.relativeName = v; })} />
          <TextField label="亲属所在公司/部门" value={value.relationshipCompliance.relativeDepartment} onChange={(v) => update((draft) => { draft.relationshipCompliance.relativeDepartment = v; })} />
          <SelectField
            label="紧急联系人关系"
            value={value.relationshipCompliance.emergencyContactRelation}
            options={[
              { value: "父亲", label: "父亲" },
              { value: "母亲", label: "母亲" },
              { value: "配偶", label: "配偶" },
              { value: "兄弟姐妹", label: "兄弟姐妹" },
              { value: "朋友", label: "朋友" },
              { value: "其他", label: "其他" },
            ]}
            onChange={(next) => update((draft) => { draft.relationshipCompliance.emergencyContactRelation = next; })}
          />
          <TextField label="紧急联系人姓名" value={value.relationshipCompliance.emergencyContactName} onChange={(v) => update((draft) => { draft.relationshipCompliance.emergencyContactName = v; })} />
          <TextField label="紧急联系人电话" value={value.relationshipCompliance.emergencyContactPhone} onChange={(v) => update((draft) => { draft.relationshipCompliance.emergencyContactPhone = v; })} />
          <SelectField label="背景调查授权" value={value.relationshipCompliance.backgroundCheckAuthorization} options={yesNoOptions} onChange={(next) => update((draft) => { draft.relationshipCompliance.backgroundCheckAuthorization = next; })} />
          <SelectField label="是否存在竞业限制" value={value.relationshipCompliance.hasNonCompete} options={yesNoOptions} onChange={(next) => update((draft) => { draft.relationshipCompliance.hasNonCompete = next; })} />
          <TextField label="健康声明" value={value.relationshipCompliance.healthDeclaration} onChange={(v) => update((draft) => { draft.relationshipCompliance.healthDeclaration = v; })} />
        </div>
        <Button size="sm" startContent={<Save size={13} />} className="bauhaus-button bauhaus-button-blue !h-8 !px-3 !py-2 !text-[11px]" onPress={saveItem} isLoading={props.saving} isDisabled={props.saving}>
          {props.saving ? "保存中..." : "保存本模块"}</Button>
      </SectionFrame>

      <SectionFrame
        sectionKey="sourceReferral"
        title="来源与推荐" description="招聘来源、内推码与推荐信息。" focused={normalizeFocusSectionKey(props.focusSection) === "sourceReferral"}
        missing={missingSet.has("sourceReferral")}
        collapsed={sectionState.isCollapsed("sourceReferral")}
        onToggleCollapse={() => sectionState.toggle("sourceReferral")}
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <SelectField
            label="招聘信息来源"
            value={value.sourceReferral.sourceChannel}
            options={[
              { value: "官网", label: "官网" },
              { value: "招聘平台", label: "招聘平台" },
              { value: "公众号", label: "公众号" },
              { value: "校园宣讲", label: "校园宣讲" },
              { value: "朋友推荐", label: "朋友推荐" },
              { value: "内推", label: "内推" },
              { value: "其他", label: "其他" },
            ]}
            onChange={(next) => update((draft) => { draft.sourceReferral.sourceChannel = next; })}
          />
          <TextField label="内推码" value={value.sourceReferral.referralCode} onChange={(v) => update((draft) => { draft.sourceReferral.referralCode = v; })} />
          <TextField label="内推人姓否" value={value.sourceReferral.referralName} onChange={(v) => update((draft) => { draft.sourceReferral.referralName = v; })} />
          <TextField label="内推人工号" value={value.sourceReferral.referralEmployeeId} onChange={(v) => update((draft) => { draft.sourceReferral.referralEmployeeId = v; })} />
          <TextField label="内推人联系方式" value={value.sourceReferral.referralContact} onChange={(v) => update((draft) => { draft.sourceReferral.referralContact = v; })} />
          <TextField label="推荐人信息" value={value.sourceReferral.recommenderInfo} onChange={(v) => update((draft) => { draft.sourceReferral.recommenderInfo = v; })} />
        </div>
        <Textarea
          label="备注"
          minRows={3}
          size="sm"
          classNames={fieldClassNames}
          value={value.sourceReferral.notes}
          onValueChange={(v) => update((draft) => { draft.sourceReferral.notes = v; })}
          variant="bordered"
        />
        <Button size="sm" startContent={<Save size={13} />} className="bauhaus-button bauhaus-button-blue !h-8 !px-3 !py-2 !text-[11px]" onPress={saveItem} isLoading={props.saving} isDisabled={props.saving}>
          {props.saving ? "保存中..." : "保存本模块"}</Button>
      </SectionFrame>

      <SectionFrame
        sectionKey="attachments"
        title="附件材料"
        description="上传后保存附件元数据（文件名、类型、大小、上传时间）。" focused={normalizeFocusSectionKey(props.focusSection) === "attachments"}
        missing={missingSet.has("attachments")}
        collapsed={sectionState.isCollapsed("attachments")}
        onToggleCollapse={() => sectionState.toggle("attachments")}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <AttachmentField label="中文简历附件" fieldType="attachments.resumeZh" value={value.attachments.resumeZh} onChange={(next) => update((draft) => { draft.attachments.resumeZh = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="英文简历附件" fieldType="attachments.resumeEn" value={value.attachments.resumeEn} onChange={(next) => update((draft) => { draft.attachments.resumeEn = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="证件照" fieldType="attachments.idPhoto" value={value.attachments.idPhoto} onChange={(next) => update((draft) => { draft.attachments.idPhoto = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="生活照" fieldType="attachments.lifePhoto" value={value.attachments.lifePhoto} onChange={(next) => update((draft) => { draft.attachments.lifePhoto = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="成绩单" fieldType="attachments.transcript" value={value.attachments.transcript} onChange={(next) => update((draft) => { draft.attachments.transcript = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="毕业证" fieldType="attachments.graduationCertificate" value={value.attachments.graduationCertificate} onChange={(next) => update((draft) => { draft.attachments.graduationCertificate = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="学位证" fieldType="attachments.degreeCertificate" value={value.attachments.degreeCertificate} onChange={(next) => update((draft) => { draft.attachments.degreeCertificate = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="学信网材料" fieldType="attachments.chsiMaterials" value={value.attachments.chsiMaterials} onChange={(next) => update((draft) => { draft.attachments.chsiMaterials = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="实习证明" fieldType="attachments.internshipCertificate" value={value.attachments.internshipCertificate} onChange={(next) => update((draft) => { draft.attachments.internshipCertificate = next; })} onSave={saveItem} saving={props.saving} />
          <AttachmentField label="职业资格证书附件" fieldType="attachments.professionalCertificates" value={value.attachments.professionalCertificates} onChange={(next) => update((draft) => { draft.attachments.professionalCertificates = next; })} onSave={saveItem} saving={props.saving} />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-semibold text-[var(--foreground)]">其他附件</div>
          <div className="space-y-2">
            {value.attachments.otherAttachments.map((attachment, index) => (
              <div key={attachment.id} className="bauhaus-panel-sm flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="text-xs text-[var(--foreground-muted)]">
                  <div className="font-medium text-[var(--foreground)]">{attachment.fileName}</div>
                  <div>{attachment.fileType || "未知类型"}  · {attachment.fileSize || 0} B</div>
                </div>
                <Button
                  size="sm"
                  className="bauhaus-button bauhaus-button-red !h-8 !px-3 !py-2 !text-[11px]"
                  onPress={() =>
                    update((draft) => {
                      draft.attachments.otherAttachments.splice(index, 1);
                    })
                  }
                >
                  删除
                </Button>
              </div>
            ))}
          </div>

          <label className="cursor-pointer">
            <span className="inline-flex">
              <Button
                size="sm"
                startContent={<Plus size={14} />}
                className="bauhaus-button bauhaus-button-outline !h-8 !px-3 !py-2 !text-[11px]"
                as="span"
              >
                上传其他附件
              </Button>
            </span>
            <input
              type="file"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                update((draft) => {
                  draft.attachments.otherAttachments.push({
                    id: `att_${Math.random().toString(36).slice(2, 10)}`,
                    fileName: file.name,
                    fileType: file.type || "",
                    fileSize: file.size,
                    uploadedAt: new Date().toISOString(),
                    fieldType: "attachments.otherAttachments",
                  });
                });
                event.target.value = "";
              }}
            />
          </label>
        </div>
      </SectionFrame>

      <SectionFrame
        sectionKey="syncSourceHint"
        title="同步来源说明"
        description="用于快速确认投递档案复用来源。" collapsed={sectionState.isCollapsed("syncSourceHint")}
        onToggleCollapse={() => sectionState.toggle("syncSourceHint")}
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <div className="bauhaus-panel-sm bg-[var(--surface)] p-3 text-sm text-[var(--foreground-muted)]">简历档案姓名：{resumeArchive.basicInfo.name || "未填写"}</div>
          <div className="bauhaus-panel-sm bg-[var(--surface)] p-3 text-sm text-[var(--foreground-muted)]">简历档案求职意向：{resumeArchive.basicInfo.jobIntention || "未填写"}</div>
        </div>
      </SectionFrame>
    </div>
  );
}
