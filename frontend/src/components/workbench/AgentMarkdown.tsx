import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// react-markdown renders to React elements: raw HTML in model output is escaped,
// and javascript:/data: links are dropped by its default URL transform.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  table: ({ node: _node, ...props }) => (
    <div className="agent-md-table custom-scrollbar">
      <table {...props} />
    </div>
  ),
};

export function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="agent-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
