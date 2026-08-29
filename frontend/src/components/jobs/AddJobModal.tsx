"use client";

import { useState } from "react";
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
} from "@nextui-org/react";
import { ingestJob, type JobPreparationMode } from "@/lib/hooks";

type AddJobModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (jobId: number | null) => void;
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
  preparationMode: "local" as JobPreparationMode,
};

export function AddJobModal({ isOpen, onClose, onCreated }: AddJobModalProps) {
  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const update = (key: keyof typeof initialForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleClose = () => {
    if (saving) return;
    setError("");
    onClose();
  };

  const handleSubmit = async () => {
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
        runtime_provider: form.preparationMode === "local" ? "replay" : "codex",
      });
      const createdId = Number(result?.created_job_ids?.[0] || 0);
      setForm(initialForm);
      onClose();
      onCreated(createdId > 0 ? createdId : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存岗位失败，请重试。");
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
            保存后，OfferU 会把岗位研究、证据差距、材料和面试准备归档到这个岗位下。
          </p>

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

          <Textarea
            label="职位描述"
            placeholder="粘贴 JD、岗位要求或你记录的关键信息"
            minRows={7}
            value={form.rawDescription}
            onValueChange={(value) => update("rawDescription", value)}
            classNames={inputClassNames}
            data-testid="add-job-description"
          />

          <div className="space-y-3">
            <p className="bauhaus-label text-[var(--foreground-muted)]">准备方式</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setForm((current) => ({ ...current, preparationMode: "local" }))}
                className={`border px-4 py-4 text-left transition ${
                  form.preparationMode === "local"
                    ? "border-[var(--border-strong)] bg-[var(--surface-muted)]"
                    : "border-[var(--border)] bg-white"
                }`}
              >
                <p className="text-sm font-bold text-[var(--foreground)]">本地准备（推荐）</p>
                <p className="mt-1 text-xs font-medium leading-relaxed text-[var(--foreground-soft)]">
                  使用可复现的本地数据完成首次体验，不需要外部登录；结果会明确标记为本地准备。
                </p>
              </button>
              <button
                type="button"
                onClick={() => setForm((current) => ({ ...current, preparationMode: "live" }))}
                className={`border px-4 py-4 text-left transition ${
                  form.preparationMode === "live"
                    ? "border-[var(--border-strong)] bg-[var(--surface-muted)]"
                    : "border-[var(--border)] bg-white"
                }`}
              >
                <p className="text-sm font-bold text-[var(--foreground)]">实时研究</p>
                <p className="mt-1 text-xs font-medium leading-relaxed text-[var(--foreground-soft)]">
                  使用已连接的 Agent Provider；认证或网络失败会显示在任务状态中，不会伪造完成。
                </p>
              </button>
            </div>
          </div>

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
            data-testid="add-job-submit"
          >
            保存并开始准备
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
