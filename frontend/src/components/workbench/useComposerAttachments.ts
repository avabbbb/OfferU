import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifyAttachmentFile,
  MAX_AGENT_ATTACHMENTS,
  type AgentAttachment,
  type AgentAttachmentKind,
} from "@/lib/agentAttachments";
import { safeClientErrorMessage } from "@/lib/safe-error";

export type ComposerAttachmentStatus = "uploading" | "ready" | "error";

export interface ComposerAttachment {
  localId: string;
  name: string;
  kind: AgentAttachmentKind;
  size: number;
  /** object URL of a local image; empty for documents and restored items */
  previewUrl: string;
  status: ComposerAttachmentStatus;
  error: string;
  /** backend id once uploaded */
  attachmentId: string;
}

let localSeq = 0;

function revoke(item: ComposerAttachment) {
  if (item.previewUrl.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
}

export function useComposerAttachments(upload: (file: File) => Promise<AgentAttachment>) {
  const [items, setItems] = useState<ComposerAttachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => itemsRef.current.forEach(revoke), []);

  const patch = useCallback((localId: string, next: Partial<ComposerAttachment>) => {
    setItems((current) => current.map((item) => (item.localId === localId ? { ...item, ...next } : item)));
  }, []);

  const addFiles = useCallback(
    (files: Iterable<File> | ArrayLike<File>) => {
      const incoming = Array.from(files);
      if (incoming.length === 0) return;
      const room = Math.max(0, MAX_AGENT_ATTACHMENTS - itemsRef.current.length);
      const added: ComposerAttachment[] = [];
      incoming.forEach((file, index) => {
        const check = classifyAttachmentFile(file);
        const overLimit = index >= room;
        const kind: AgentAttachmentKind = check.ok ? check.kind : "document";
        localSeq += 1;
        const item: ComposerAttachment = {
          localId: "attachment-" + Date.now() + "-" + localSeq,
          name: file.name || "未命名文件",
          kind,
          size: file.size,
          previewUrl: check.ok && kind === "image" && !overLimit ? URL.createObjectURL(file) : "",
          status: "uploading",
          error: "",
          attachmentId: "",
        };
        if (overLimit) {
          // Only the first file past the limit is shown, as the reason; the rest are dropped.
          if (index === room) {
            added.push({ ...item, status: "error", error: "一次最多 " + MAX_AGENT_ATTACHMENTS + " 个附件" });
          }
          return;
        }
        if (!check.ok) {
          added.push({ ...item, status: "error", error: check.reason });
          return;
        }
        added.push(item);
        upload(file).then(
          (stored) => patch(item.localId, { status: "ready", attachmentId: stored.id, name: stored.name }),
          (err: unknown) => patch(item.localId, { status: "error", error: safeClientErrorMessage(err, "上传失败") }),
        );
      });
      setItems((current) => [...current, ...added]);
    },
    [patch, upload],
  );

  const remove = useCallback((localId: string) => {
    setItems((current) => {
      const target = current.find((item) => item.localId === localId);
      if (target) revoke(target);
      return current.filter((item) => item.localId !== localId);
    });
  }, []);

  /** Hands the uploaded attachments to a send and empties the tray. */
  const takeForSend = useCallback((): ComposerAttachment[] => {
    const ready = itemsRef.current.filter((item) => item.status === "ready");
    itemsRef.current.forEach(revoke);
    setItems([]);
    return ready.map((item) => ({ ...item, previewUrl: "" }));
  }, []);

  /** Puts a failed send's attachments back so the user can retry. */
  const restore = useCallback((restored: ComposerAttachment[]) => {
    if (restored.length === 0) return;
    setItems((current) => [...restored, ...current].slice(0, MAX_AGENT_ATTACHMENTS));
  }, []);

  return {
    items,
    addFiles,
    remove,
    takeForSend,
    restore,
    uploading: items.some((item) => item.status === "uploading"),
    readyCount: items.filter((item) => item.status === "ready").length,
  };
}
