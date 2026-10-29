import { describe, expect, it } from "vitest";

import {
  classifyAttachmentFile,
  formatAttachmentSize,
  hasDraggedFiles,
  MAX_AGENT_DOCUMENT_BYTES,
  MAX_AGENT_IMAGE_BYTES,
  parseAgentAttachment,
} from "./agentAttachments";

describe("classifyAttachmentFile", () => {
  it("accepts images, PDF and PPTX by extension", () => {
    expect(classifyAttachmentFile({ name: "shot.PNG", size: 10 })).toEqual({ ok: true, kind: "image" });
    expect(classifyAttachmentFile({ name: "resume.pdf", size: 10 })).toEqual({ ok: true, kind: "document" });
    expect(classifyAttachmentFile({ name: "deck.pptx", size: 10 })).toEqual({ ok: true, kind: "document" });
  });

  it("rejects other types, empty files and oversize files with a reason", () => {
    expect(classifyAttachmentFile({ name: "clip.mp4", size: 10 })).toMatchObject({ ok: false });
    expect(classifyAttachmentFile({ name: "old.ppt", size: 10 })).toMatchObject({ ok: false });
    expect(classifyAttachmentFile({ name: "a.png", size: 0 })).toMatchObject({ ok: false, reason: "文件是空的" });
    expect(classifyAttachmentFile({ name: "a.png", size: MAX_AGENT_IMAGE_BYTES + 1 })).toMatchObject({
      ok: false,
      reason: "图片不能超过 8 MB",
    });
    expect(classifyAttachmentFile({ name: "a.pdf", size: MAX_AGENT_DOCUMENT_BYTES + 1 })).toMatchObject({
      ok: false,
      reason: "文档不能超过 25 MB",
    });
  });
});

describe("parseAgentAttachment", () => {
  it("keeps a well-formed upload result", () => {
    const value = { id: "abc.png", name: "a.png", kind: "image", mime_type: "image/png", size: 3 };
    expect(parseAgentAttachment(value)).toEqual(value);
  });

  it("refuses anything else", () => {
    expect(parseAgentAttachment(null)).toBeNull();
    expect(parseAgentAttachment({ id: "x" })).toBeNull();
    expect(parseAgentAttachment({ id: "x", name: "a", kind: "video", mime_type: "v", size: 1 })).toBeNull();
    expect(parseAgentAttachment({ id: "", name: "a", kind: "image", mime_type: "v", size: 1 })).toBeNull();
  });
});

it("formats sizes and spots file drags", () => {
  expect(formatAttachmentSize(512)).toBe("512 B");
  expect(formatAttachmentSize(2048)).toBe("2 KB");
  expect(formatAttachmentSize(3145728)).toBe("3.0 MB");
  expect(hasDraggedFiles(["Files"])).toBe(true);
  expect(hasDraggedFiles(["text/plain"])).toBe(false);
});
