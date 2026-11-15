// PPTX → text, the way backend/app/services/agent_attachments.py _pptx_text
// reads it with python-pptx: slides in presentation order, each shape's text
// frame (paragraphs joined by "\n", <a:br/> as "\v"), tables as "a | b" rows,
// groups recursively, then the notes placeholder as "备注：…".

import { zipEntries, zipRead, ZipError, type ZipEntry } from "./zip";
import { childNamed, childrenNamed, findAll, findFirst, parseXml, type XmlNode } from "./xml";

export const MAX_SLIDES = 200;
export const MAX_PPTX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

export class PptxError extends Error {}

/** python-pptx _Paragraph.text: runs and fields, <a:br/> → "\v". */
function paragraphText(paragraph: XmlNode): string {
  let text = "";
  for (const child of paragraph.children) {
    if (child.name === "a:r" || child.name === "a:fld") text += childNamed(child, "a:t")?.text ?? "";
    else if (child.name === "a:br") text += "\v";
  }
  return text;
}

/** TextFrame.text: paragraphs joined by "\n". */
const frameText = (body: XmlNode): string => childrenNamed(body, "a:p").map(paragraphText).join("\n");

function shapeLines(shape: XmlNode): string[] {
  if (shape.name === "p:grpSp") {
    return shape.children.flatMap(shapeLines);
  }
  if (shape.name === "p:graphicFrame") {
    const table = findFirst(shape, "a:tbl");
    if (!table) return [];
    const rows: string[] = [];
    for (const row of childrenNamed(table, "a:tr")) {
      const cells = childrenNamed(row, "a:tc").map((cell) => {
        const body = childNamed(cell, "a:txBody");
        return body ? frameText(body).trim() : "";
      });
      if (cells.some(Boolean)) rows.push(cells.join(" | "));
    }
    return rows;
  }
  if (shape.name === "p:sp") {
    const body = childNamed(shape, "p:txBody");
    if (!body) return [];
    const text = frameText(body).trim();
    return text ? [text] : [];
  }
  return [];
}

function relTargets(xml: string, base: string): Map<string, { type: string; target: string }> {
  const map = new Map<string, { type: string; target: string }>();
  for (const rel of findAll(parseXml(xml), "Relationship")) {
    map.set(rel.attrs.Id, { type: rel.attrs.Type ?? "", target: resolvePath(base, rel.attrs.Target ?? "") });
  }
  return map;
}

function resolvePath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

const relsPathOf = (part: string): string => {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
};

/** Notes placeholder text (python-pptx NotesSlide.notes_text_frame: the body placeholder). */
function notesText(xml: string): string {
  const tree = parseXml(xml);
  for (const shape of findAll(tree, "p:sp")) {
    const ph = findFirst(shape, "p:ph");
    if (ph && ph.attrs.type === "body") {
      const body = childNamed(shape, "p:txBody");
      return body ? frameText(body).trim() : "";
    }
  }
  return "";
}

export async function pptxText(bytes: Uint8Array): Promise<string> {
  let entries: ZipEntry[];
  try {
    entries = zipEntries(bytes);
  } catch (error) {
    if (error instanceof ZipError) throw new PptxError("这个 PPTX 无法打开，可能已损坏");
    throw error;
  }
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  if (!byName.has("ppt/presentation.xml")) throw new PptxError("这不是一个 PowerPoint (.pptx) 文件");
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_PPTX_UNCOMPRESSED_BYTES) throw new PptxError("这个 PPTX 解压后太大，无法读取");

  const decoder = new TextDecoder();
  const read = async (name: string): Promise<string | null> => {
    const entry = byName.get(name);
    return entry ? decoder.decode(await zipRead(bytes, entry)) : null;
  };

  try {
    const presentation = parseXml((await read("ppt/presentation.xml")) ?? "");
    const rels = relTargets((await read("ppt/_rels/presentation.xml.rels")) ?? "", "ppt/presentation.xml");
    const slideParts = findAll(presentation, "p:sldId").map((node) => rels.get(node.attrs["r:id"])?.target).filter((part): part is string => Boolean(part));
    const pages: string[] = [];
    for (const [index0, part] of slideParts.entries()) {
      const index = index0 + 1;
      if (index > MAX_SLIDES) {
        pages.push(`（第 ${MAX_SLIDES} 页之后未读取）`);
        break;
      }
      const slide = parseXml((await read(part)) ?? "");
      const tree = findFirst(slide, "p:spTree");
      const lines = tree ? tree.children.flatMap(shapeLines) : [];
      const slideRels = relTargets((await read(relsPathOf(part))) ?? "", part);
      const notesPart = [...slideRels.values()].find((rel) => rel.type.endsWith("/notesSlide"))?.target;
      const notesXml = notesPart ? await read(notesPart) : null;
      const notes = notesXml ? notesText(notesXml) : "";
      if (notes) lines.push(`备注：${notes}`);
      pages.push(`第 ${index} 页\n` + (lines.length ? lines.join("\n") : "（此页没有文字）"));
    }
    return pages.join("\n\n").trim();
  } catch (error) {
    if (error instanceof PptxError) throw error;
    throw new PptxError("这个 PPTX 无法打开，可能已损坏");
  }
}
