"use client";

import { useState } from "react";

// 标签输入：回车或逗号建新标签（中文输入法拼字时不算），空输入时退格删最后一个，上下键选已有标签，Esc 或点别处关掉。
export function TagInput({ value, options, onChange, onClose }: {
  value: string[];
  options: string[];
  onChange: (tags: string[]) => void;
  onClose: () => void;
}) {
  const [tags, setTags] = useState(value);
  const [text, setText] = useState("");
  const [index, setIndex] = useState(-1);
  const query = text.trim();
  const matches = options.filter((t) => !tags.includes(t) && t.includes(query)).slice(0, 6);
  const commit = (next: string[]) => { setTags(next); onChange(next); };
  const add = (raw: string) => {
    const tag = raw.trim().slice(0, 20);
    if (tag && !tags.includes(tag) && tags.length < 12) commit([...tags, tag]);
    setText("");
    setIndex(-1);
  };

  return (
    <div className="tag-input">
      <div className="tag-input-box">
        {tags.map((tag) => (
          <button key={tag} type="button" className="tag-pill" title="去掉这个标签"
            onMouseDown={(e) => e.preventDefault()} onClick={() => commit(tags.filter((t) => t !== tag))}>
            #{tag} ×
          </button>
        ))}
        <input autoFocus value={text} aria-label="加标签" placeholder={tags.length ? "" : "输入标签，回车"}
          onChange={(e) => { setText(e.target.value); setIndex(-1); }}
          onBlur={onClose}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter" || e.key === "," || e.key === "，") {
              e.preventDefault();
              add(index >= 0 ? matches[index] : text);
            } else if (e.key === "Backspace" && !text && tags.length) {
              commit(tags.slice(0, -1));
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, -1));
            } else if (e.key === "Escape") {
              onClose();
            }
          }} />
      </div>
      {matches.length > 0 && (
        <ul className="tag-menu" role="listbox" aria-label="已有标签">
          {matches.map((tag, i) => (
            <li key={tag} role="option" aria-selected={i === index}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); add(tag); }}>#{tag}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
