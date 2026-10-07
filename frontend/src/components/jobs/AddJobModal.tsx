"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from "@heroui/react";
import { ingestJob, type JobPreparationMode } from "@/lib/hooks";
import { safeClientErrorMessage } from "@/lib/safe-error";

type AddJobModalProps = {
  isOpen: boolean;
  onClose: (reason?: "dismissed" | "created") => void;
  onCreated: (jobId: number | null) => void;
  guided?: boolean;
};

const inputClassNames = {
  inputWrapper: "rounded-none border border-[var(--border)] bg-white shadow-none",
  input: "text-[var(--foreground)]",
  label: "font-semibold text-[11px] text-[var(--foreground-muted)]",
};

const initialForm = {
  title: "",
  company: "",
  location: "",
  url: "",
  rawDescription: "",
  preparationMode: "live" as JobPreparationMode,
};

export function AddJobModal({ isOpen, onClose, onCreated, guided = false }: AddJobModalProps) {
  const [form, setForm] = useState({ ...initialForm, preparationMode: guided ? "live" as const : initialForm.preparationMode });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (guided && isOpen) setForm((current) => ({ ...current, preparationMode: "live" }));
  }, [guided, isOpen]);

  const update = (key: keyof typeof initialForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleClose = () => {
    if (saving) return;
    setError("");
    onClose("dismissed");
  };

  const handleSubmit = async () => {
    if (saving) return;

    const title = form.title.trim();
    const company = form.company.trim();
    const rawDescription = form.rawDescription.trim();
    if (!title || !company || !rawDescription) {
      setError("请填写岗位名称、公司和职位描述，OfferU 才能开始准备。");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const result = await ingestJob({
        title,
        company,
        location: form.location.trim(),
        url: form.url.trim(),
        raw_description: rawDescription,
        source: "manual",
        runtime_provider: form.preparationMode === "local" ? "replay" : "auto",
      });
      const createdId = Number(
        result?.created_job_ids?.[0] || result?.resolved_job_ids?.[0] || 0,
      );
      setForm({ ...initialForm, preparationMode: guided ? "live" : initialForm.preparationMode });
      onClose(createdId > 0 ? "created" : "dismissed");
      onCreated(createdId > 0 ? createdId : null);
    } catch (reason) {
      setError(safeClientErrorMessage(reason, "保存岗位失败，请重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} placement="center" size="2xl" data-testid="add-job-modal">
      <ModalContent className="rounded-none border border-[var(--border-strong)] bg-[var(--surface)]">
        <ModalHeader className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-6 py-5 text-xl font-semibold">
          保存一个目标岗位
        </ModalHeader>
        <ModalBody className="space-y-5 px-6 py-6">
          <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
            粘贴职位描述，填上岗位和公司。保存后会直接打开这个岗位的工作区，岗位情报在后台准备。
          </p>

          <Textarea
            label="职位描述"
            placeholder="粘贴 JD、岗位要求或你记录的关键信息"
            minRows={7}
            value={form.rawDescription}
            onValueChange={(value) => update("rawDescription", value)}
            classNames={inputClassNames}
            data-testid="add-job-description"
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="岗位名称"
              placeholder="例如：AI 产品经理"
              value={form.title}
              onValueChange={(value) => update("title", value)}
              classNames={inputClassNames}
              data-testid="add-job-title"
              autoFocus
            />
            <Input
              label="公司"
              placeholder="例如：月之暗面"
              value={form.company}
              onValueChange={(value) => update("company", value)}
              classNames={inputClassNames}
              data-testid="add-job-company"
            />
            <Input
              label="地点（可选）"
              placeholder="例如：北京 / 远程"
              value={form.location}
              onValueChange={(value) => update("location", value)}
              classNames={inputClassNames}
            />
            <Input
              label="岗位链接（可选）"
              placeholder="粘贴招聘页面链接"
              value={form.url}
              onValueChange={(value) => update("url", value)}
              classNames={inputClassNames}
            />
          </div>



          {guided ? (
            <p role="note" className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--foreground-muted)]">
              OfferU 会使用当前可用的研究配置开始准备。认证或网络问题会显示为可重试状态，不会用演示结果代替。
            </p>
          ) : (
            <label className="flex items-start gap-2 text-xs leading-5 text-[var(--foreground-muted)]">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.preparationMode === "local"}
                onChange={(event) => setForm((current) => ({ ...current, preparationMode: event.target.checked ? "local" : "live" }))}
                data-testid="add-job-demo-mode"
              />
              <span>
                用离线演示数据体验流程（不联网、不调用模型；结果是内置示例，不代表真实岗位研究）
              </span>
            </label>
          )}

          {error && (
            <div className="border border-[var(--primary-red)]/40 bg-[var(--status-blush)] px-4 py-3 text-sm font-medium leading-relaxed text-[var(--primary-red)]" role="alert">
              {error}
            </div>
          )}
        </ModalBody>
        <ModalFooter className="border-t border-[var(--border)] px-6 py-5">
          <Button
            variant="light"
            className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]"
            onPress={handleClose}
            isDisabled={saving}
          >
            取消
          </Button>
          <Button
            className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]"
            onPress={() => void handleSubmit()}
            isLoading={saving}
            isDisabled={saving}
            data-testid="add-job-submit"
          >
            保存并开始准备
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
