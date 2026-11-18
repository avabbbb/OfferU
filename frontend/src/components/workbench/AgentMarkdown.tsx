import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo } from "react";
import { openAgentImage } from "./AgentMessageActions";

// react-markdown renders to React elements: raw HTML in model output is escaped,
// and javascript:/data: links are dropped by its default URL transform.
/** 回答里的 Markdown 图片（按出现顺序），点开大图后 ←→ 在它们之间切换。 */
export function markdownImages(text: string): Array<{ src: string; name: string }> {
  const out: Array<{ src: string; name: string }> = [];
  const pattern = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const match of text.matchAll(pattern)) out.push({ src: match[2], name: match[1] });
  return out;
}

const baseComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _node, ...props }) => (
    <div className="agent-md-table custom-scrollbar">
      <table {...props} />
    </div>
  ),
};

export function AgentMarkdown({ text }: { text: string }) {
  const components = useMemo<Components>(() => {
    const images = markdownImages(text);
    return {
      ...baseComponents,
      // 点开看大图（AgentImageViewer）；图片 URL 已经过 react-markdown 的 URL 过滤。
      img: ({ node: _node, src, alt }) => {
        if (!src) return null;
        const found = images.findIndex((image) => image.src === src);
        const gallery = found >= 0 ? images : [{ src, name: alt || "" }];
        return (
          <button type="button" className="agent-md-image" aria-label={`看大图${alt ? "：" + alt : ""}`} title="点开看大图"
            onClick={() => openAgentImage({ images: gallery, index: Math.max(0, found) })}>
            <img src={src} alt={alt || ""} loading="lazy" />
          </button>
        );
      },
    };
  }, [text]);
  return (
    <div className="agent-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
