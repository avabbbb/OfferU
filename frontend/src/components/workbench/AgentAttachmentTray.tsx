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

// 输入框附件（参考 Inspora「composer mockup」）：图片排成拼贴——1 张铺满、2 张对半、3 张左一大右两小、4 张田字；
// 文档是下面一排小胶囊。悬停图片右上角出圆形 ×。
export function AgentAttachmentTray({
  items,
  onRemove,
}: {
  items: ComposerAttachment[];
  onRemove: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  const images = items.filter((item) => item.kind === "image" && item.previewUrl && item.status !== "error");
  const others = items.filter((item) => !images.includes(item));
  const remove = (item: ComposerAttachment) => (
    <button type="button" className="agent-attachment-remove" aria-label={"移除 " + item.name} onClick={() => onRemove(item.localId)}>
      <X size={12} strokeWidth={2.4} />
    </button>
  );
  return (
    <div className="agent-attachment-tray" aria-label="附件" data-testid="agent-attachment-tray">
      {images.length > 0 && (
        <ul className="agent-mosaic" data-count={Math.min(images.length, 4)}>
          {images.slice(0, 4).map((item) => (
            <li key={item.localId} className="agent-mosaic-tile ou-enter" data-status={item.status} title={item.name}>
              <img src={item.previewUrl} alt={item.name} />
              {item.status === "uploading" && <span className="agent-attachment-busy"><Loader2 size={14} className="animate-spin" /></span>}
              {remove(item)}
            </li>
          ))}
          {images.length > 4 && <li className="agent-mosaic-more">+{images.length - 4}</li>}
        </ul>
      )}
      {(others.length > 0 || images.length > 4) && (
        <ul className="agent-attachment-chips">
          {[...images.slice(4), ...others].map((item) => (
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
              {remove(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
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
