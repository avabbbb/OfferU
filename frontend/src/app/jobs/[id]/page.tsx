"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Button,
  Card,
  CardBody,
  Chip,
  Link,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Spinner,
} from "@nextui-org/react";
import {
  ArrowLeft,
  Building2,
  Calendar,
  ExternalLink,
  MapPin,
  Send,
} from "lucide-react";
import { createApplication, patchJob, useJob, usePools } from "@/lib/hooks";
import {
  bauhausModalContentClassName,
  bauhausSelectClassNames,
} from "@/lib/bauhaus";

export default function JobDetailPage() {
  const params = useParams();
  const router = useRouter();
  const jobId = params.id ? Number(params.id) : null;
  const { data: job, isLoading, error } = useJob(jobId);
  const { data: pickedPools } = usePools("picked");
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [trashConfirmOpen, setTrashConfirmOpen] = useState(false);
  const [targetPool, setTargetPool] = useState<string>("ungrouped");
  const [actionLoading, setActionLoading] = useState<"join" | "trash" | null>(null);

  const poolOptions = useMemo(
    () => [{ key: "ungrouped", label: "未分组" }, ...((pickedPools || []).map((pool) => ({ key: String(pool.id), label: pool.name })))],
    [pickedPools]
  );

  const handleJoinPicked = async () => {
    if (!job) return;
    try {
      setActionLoading("join");
      if (targetPool === "ungrouped") {
        await patchJob(job.id, { triage_status: "picked", clear_pool: true });
      } else {
        await patchJob(job.id, { triage_status: "picked", pool_id: Number(targetPool) });
      }
      setJoinModalOpen(false);
      router.push("/jobs?tab=picked");
    } catch (err: any) {
      alert(err?.message || "加入已筛选失败");
    } finally {
      setActionLoading(null);
    }
  };

  const handleMoveToTrash = async () => {
    if (!job) return;
    try {
      setActionLoading("trash");
      await patchJob(job.id, { triage_status: "ignored" });
      setTrashConfirmOpen(false);
      router.push("/jobs?tab=ignored");
    } catch (err: any) {
      alert(err?.message || "移入回收站失败");
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <div className="bauhaus-panel-sm flex items-center gap-3 bg-white px-5 py-4">
          <Spinner size="sm" color="warning" />
          <span className="text-sm font-semibold tracking-[0.04em] text-[var(--foreground-soft)]">正在载入岗位详情...</span>
        </div>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="flex min-h-[420px] items-center justify-center">
        <div className="bauhaus-panel bg-white p-8 text-center">
          <p className="text-lg font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">岗位不存在或加载失败</p>
          <Button onPress={() => router.push("/jobs")} className="bauhaus-button bauhaus-button-outline mt-5 !px-4 !py-3 !text-[11px]">
            返回列表
          </Button>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      className="mx-auto max-w-5xl space-y-8"
    >
      <section className="bauhaus-panel overflow-hidden bg-white">
        <div className="grid gap-6 p-6 md:p-8 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                isIconOnly
                variant="light"
                onPress={() => router.push("/jobs")}
                className="min-h-11 min-w-11 border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] "
              >
                <ArrowLeft size={18} />
              </Button>
              <span className="bauhaus-chip bg-[var(--surface-muted)] text-[var(--foreground)]">岗位档案</span>
            </div>

            <div>
              <p className="bauhaus-label text-[var(--foreground-muted)]">详情表</p>
              <h1 className="mt-3 text-4xl font-black leading-[0.92] tracking-[-0.06em] text-[var(--foreground)] sm:text-5xl">
                {job.title}
              </h1>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm font-medium text-[var(--foreground-muted)]">
                <span className="flex items-center gap-1"><Building2 size={14} /> {job.company}</span>
                <span className="flex items-center gap-1"><MapPin size={14} /> {job.location || "未知地点"}</span>
                {job.posted_at && <span className="flex items-center gap-1"><Calendar size={14} /> {job.posted_at}</span>}
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">来源</p>
              <p className="mt-3 text-2xl font-black uppercase tracking-[-0.05em]">{job.source}</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)]">
              <p className="bauhaus-label text-[var(--foreground-muted)]">关键词</p>
              <p className="mt-3 text-2xl font-black uppercase tracking-[-0.05em]">{job.keywords?.length ?? 0}</p>
            </div>
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] p-4 text-[var(--foreground)] sm:col-span-2 xl:col-span-1">
              <p className="bauhaus-label text-[var(--foreground-muted)]">操作</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onPress={() => setJoinModalOpen(true)} isLoading={actionLoading === "join"} className="bauhaus-button bauhaus-button-yellow !px-4 !py-3 !text-[11px]">
                  加入已筛选
                </Button>
                <Button onPress={() => setTrashConfirmOpen(true)} isLoading={actionLoading === "trash"} isDisabled={actionLoading === "join"} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
                  移入回收站
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {job.summary && (
        <Card className="bauhaus-panel rounded-none bg-white shadow-none">
          <CardBody className="p-5">
            <p className="bauhaus-label text-[var(--foreground-muted)]">AI 摘要</p>
            <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">岗位摘要</h2>
            <p className="mt-4 text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">{job.summary}</p>
          </CardBody>
        </Card>
      )}

      <Card className="bauhaus-panel rounded-none bg-white shadow-none">
        <CardBody className="space-y-4 p-5">
          <div>
            <p className="bauhaus-label text-[var(--foreground-muted)]">原始描述</p>
            <h2 className="mt-2 text-2xl font-black uppercase tracking-[-0.05em] text-[var(--foreground)]">职位描述</h2>
          </div>
          {job.raw_description ? (
            <div className="bauhaus-panel-sm max-h-[460px] overflow-auto bg-[var(--surface-muted)] p-4">
              <pre className="whitespace-pre-wrap text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
                {job.raw_description}
              </pre>
            </div>
          ) : (
            <div className="bauhaus-panel-sm bg-[var(--surface-muted)] px-4 py-4 text-sm font-medium text-[var(--foreground-muted)]">
              暂无 JD 原文内容。
            </div>
          )}
        </CardBody>
      </Card>

      {job.keywords?.length > 0 && (
        <section className="flex flex-wrap gap-2">
          {job.keywords.map((keyword, index) => (
            <Chip
              key={keyword}
              size="sm"
              variant="flat"
              className={`border border-[var(--border)] font-semibold ${
                index % 3 === 0
                  ? "bg-[var(--primary-red)] text-white"
                  : index % 3 === 1
                    ? "bg-[var(--surface-muted)] text-[var(--foreground)]"
                    : "bg-white text-[var(--foreground)]"
              }`}
            >
              {keyword}
            </Chip>
          ))}
        </section>
      )}

      <section className="grid gap-3 md:grid-cols-2">
        <Button onPress={() => setJoinModalOpen(true)} isLoading={actionLoading === "join"} className="bauhaus-button bauhaus-button-yellow !justify-center !px-4 !py-3 !text-[11px]">
          加入已筛选
        </Button>
        <Button onPress={() => setTrashConfirmOpen(true)} isLoading={actionLoading === "trash"} isDisabled={actionLoading === "join"} className="bauhaus-button bauhaus-button-red !justify-center !px-4 !py-3 !text-[11px]">
          移入回收站
        </Button>
        {job.url ? (
          <Button
            as={Link}
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            endContent={<ExternalLink size={16} />}
            className="bauhaus-button bauhaus-button-outline !justify-center !px-4 !py-3 !text-[11px]"
          >
            查看原文
          </Button>
        ) : (
          <Button isDisabled className="bauhaus-button bauhaus-button-outline !justify-center !px-4 !py-3 !text-[11px] opacity-60">
            查看原文
          </Button>
        )}
        <Button
          endContent={<Send size={16} />}
          onPress={async () => {
            await createApplication(job.id);
            router.push("/applications");
          }}
          className="bauhaus-button bauhaus-button-blue !justify-center !px-4 !py-3 !text-[11px]"
        >
          一键投递
        </Button>
      </section>

      <Modal isOpen={joinModalOpen} onClose={() => setJoinModalOpen(false)} size="md">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-6 py-5 text-xl font-black tracking-[-0.06em]">
            加入已筛选
          </ModalHeader>
          <ModalBody className="space-y-3 px-6 py-6">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">选择目标池，确认后将该岗位流转到已筛选。</p>
            <Select
              aria-label="目标已筛选池"
              selectedKeys={[targetPool]}
              onSelectionChange={(keys) => setTargetPool(Array.from(keys)[0] as string)}
              items={poolOptions}
              classNames={bauhausSelectClassNames}
            >
              {(item) => <SelectItem key={item.key}>{item.label}</SelectItem>}
            </Select>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={() => setJoinModalOpen(false)} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
              取消
            </Button>
            <Button onPress={handleJoinPicked} isLoading={actionLoading === "join"} className="bauhaus-button bauhaus-button-blue !px-4 !py-3 !text-[11px]">
              确认加入
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={trashConfirmOpen} onClose={() => setTrashConfirmOpen(false)} size="md">
        <ModalContent className={bauhausModalContentClassName}>
          <ModalHeader className="border-b border-[var(--border)] bg-[var(--surface-muted)] px-6 py-5 text-xl font-black tracking-[-0.06em] text-[var(--foreground)]">
            移入回收站
          </ModalHeader>
          <ModalBody className="px-6 py-6">
            <p className="text-sm font-medium leading-relaxed text-[var(--foreground-soft)]">
              确认将该岗位移入回收站吗？移入后可在回收站页面恢复或永久删除。
            </p>
          </ModalBody>
          <ModalFooter className="border-t border-[var(--border-strong)] px-6 py-5">
            <Button variant="light" onPress={() => setTrashConfirmOpen(false)} className="bauhaus-button bauhaus-button-outline !px-4 !py-3 !text-[11px]">
              取消
            </Button>
            <Button isLoading={actionLoading === "trash"} onPress={handleMoveToTrash} className="bauhaus-button bauhaus-button-red !px-4 !py-3 !text-[11px]">
              确认移入
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </motion.div>
  );
}
