import type { KeyboardEvent } from "react";
import { FileText, Loader2, Presentation, X } from "lucide-react";
import { attachmentExtension, formatAttachmentSize, type AgentAttachmentKind } from "@/lib/agentAttachments";
import { useApiAssetUrl } from "@/lib/apiAsset";
import type { ComposerAttachment } from "./useComposerAttachments";
import { openAgentImage } from "./AgentMessageActions";

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
/**
 * 附件托盘的键盘：焦点在某个附件的「×」上时，←/→/↑/↓ 在附件之间移动、Delete / Backspace 移除并把焦点给相邻那个、
 * Esc 回到输入框。从输入框 Tab 进来即可，不用鼠标。
 */
export function attachmentTrayKeyDown(event: KeyboardEvent<HTMLElement>, onExit?: () => void) {
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".agent-attachment-remove"));
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  const focus = (next: number) => { event.preventDefault(); buttons[(next + buttons.length) % buttons.length]?.focus(); };
  if (event.key === "ArrowRight" || event.key === "ArrowDown") focus(index + 1);
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") focus(index - 1);
  else if (event.key === "Home") focus(0);
  else if (event.key === "End") focus(buttons.length - 1);
  else if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    const neighbour = buttons[index + 1] || buttons[index - 1];
    buttons[index].click();
    if (neighbour) window.requestAnimationFrame(() => neighbour.focus());
    else onExit?.();
  } else if (event.key === "Escape") {
    event.preventDefault();
    onExit?.();
  }
}

export function AgentAttachmentTray({
  items,
  onRemove,
  onExit,
}: {
  items: ComposerAttachment[];
  onRemove: (localId: string) => void;
  /** Esc / 删完最后一个时把焦点还给输入框。 */
  onExit?: () => void;
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
    <div className="agent-attachment-tray" aria-label="附件（←→ 切换，Delete 移除，Esc 回到输入框）" data-testid="agent-attachment-tray"
      onKeyDown={(event) => attachmentTrayKeyDown(event, onExit)}>
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

// 网页版 /api/* 由页面内后端回答，<a>/<img> 不走 fetch，所以先读成 blob: URL（见 lib/apiAsset）。
// 点开看大图（AgentImageViewer，←→ 切换同一条消息里的图）；拼贴按张数排版，见 globals.css 的 [data-images]。
function MessageImage({ attachment, url, onOpen }: { attachment: SentAttachment; url: string; onOpen: () => void }) {
  const src = useApiAssetUrl(url);
  return (
    <button type="button" className="agent-message-image" title={`${attachment.name}（点开看大图）`} aria-label={`看大图：${attachment.name}`} onClick={onOpen}>
      {src ? <img src={src} alt={attachment.name} /> : null}
    </button>
  );
}

/** 图片拼贴的排版档：1 张大图、2 张对半、3 张及以上两列方格。 */
export function imageCollageLayout(count: number): "1" | "2" | "many" | undefined {
  if (count <= 0) return undefined;
  if (count === 1) return "1";
  if (count === 2) return "2";
  return "many";
}

export function AgentMessageAttachments({
  attachments,
  imageUrl,
}: {
  attachments: SentAttachment[];
  imageUrl: (id: string) => string;
}) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((attachment) => attachment.kind === "image");
  const gallery = images.map((attachment) => ({ src: imageUrl(attachment.id), name: attachment.name }));
  return (
    <div className="agent-message-attachments" data-testid="agent-message-attachments" data-images={imageCollageLayout(images.length)}>
      {attachments.map((attachment) =>
        attachment.kind === "image" ? (
          <MessageImage key={attachment.id} attachment={attachment} url={imageUrl(attachment.id)}
            onOpen={() => openAgentImage({ images: gallery, index: images.indexOf(attachment) })} />
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
