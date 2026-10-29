import { FileText, Loader2, Presentation, X } from "lucide-react";
import { attachmentExtension, formatAttachmentSize, type AgentAttachmentKind } from "@/lib/agentAttachments";
import type { ComposerAttachment } from "./useComposerAttachments";

/** What a sent user message keeps of its attachments. */
export interface SentAttachment {
  id: string;
  name: string;
  kind: AgentAttachmentKind;
}

function DocumentIcon({ name }: { name: string }) {
  return attachmentExtension(name) === "pptx" ? <Presentation size={16} /> : <FileText size={16} />;
}

function statusLine(item: ComposerAttachment): string {
  if (item.status === "error") return item.error;
  if (item.status === "uploading") return item.kind === "document" ? "上传并读取中..." : "上传中...";
  return formatAttachmentSize(item.size);
}

export function AgentAttachmentTray({
  items,
  onRemove,
}: {
  items: ComposerAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="agent-attachment-tray" aria-label="附件" data-testid="agent-attachment-tray">
      {items.map((item) => (
        <li
          key={item.localId}
          className={item.status === "error" ? "agent-attachment-chip is-error" : "agent-attachment-chip"}
          data-status={item.status}
          title={item.error || item.name}
        >
          <span className="agent-attachment-thumb">
            {item.kind === "image" && item.previewUrl ? <img src={item.previewUrl} alt="" /> : <DocumentIcon name={item.name} />}
            {item.status === "uploading" && (
              <span className="agent-attachment-busy">
                <Loader2 size={14} className="animate-spin" />
              </span>
            )}
          </span>
          <span className="agent-attachment-meta">
            <span className="agent-attachment-name">{item.name}</span>
            <span className="agent-attachment-sub">{statusLine(item)}</span>
          </span>
          <button
            type="button"
            className="agent-attachment-remove"
            aria-label={"移除 " + item.name}
            onClick={() => onRemove(item.localId)}
          >
            <X size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AgentMessageAttachments({
  attachments,
  imageUrl,
}: {
  attachments: SentAttachment[];
  imageUrl: (id: string) => string;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="agent-message-attachments" data-testid="agent-message-attachments">
      {attachments.map((attachment) =>
        attachment.kind === "image" ? (
          <a
            key={attachment.id}
            href={imageUrl(attachment.id)}
            target="_blank"
            rel="noreferrer"
            className="agent-message-image"
            title={attachment.name}
          >
            <img src={imageUrl(attachment.id)} alt={attachment.name} />
          </a>
        ) : (
          <span key={attachment.id} className="agent-message-file" title={attachment.name}>
            <DocumentIcon name={attachment.name} />
            <span>{attachment.name}</span>
          </span>
        ),
      )}
    </div>
  );
}
