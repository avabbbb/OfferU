// Tiny XML tree parser for OOXML parts (no DTDs, no namespaces resolution:
// element names keep their prefix, e.g. "p:sp"). Enough for reading slide text.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated character data directly inside this element. */
  text: string;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITY[code] ?? whole;
  });
}

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>/g;
  let last = 0;
  for (let match = tag.exec(source); match; match = tag.exec(source)) {
    const top = stack[stack.length - 1];
    if (match.index > last) top.text += decodeEntities(source.slice(last, match.index));
    last = tag.lastIndex;
    if (match[1] !== undefined) { top.text += match[1]; continue; }
    if (!match[3]) continue; // comment / PI / doctype
    if (match[2] === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of match[4].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      attrs[attr[1]] = decodeEntities(attr[3] ?? attr[4] ?? "");
    }
    const node: XmlNode = { name: match[3], attrs, children: [], text: "" };
    top.children.push(node);
    if (match[5] !== "/") stack.push(node);
  }
  return root;
}

export const childrenNamed = (node: XmlNode, name: string): XmlNode[] => node.children.filter((child) => child.name === name);
export const childNamed = (node: XmlNode, name: string): XmlNode | undefined => node.children.find((child) => child.name === name);

export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
    const deep = findFirst(child, name);
    if (deep) return deep;
  }
  return undefined;
}
