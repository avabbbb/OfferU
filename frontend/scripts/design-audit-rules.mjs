/* Shared detector for OfferU UI additions. Existing debt is reported, not gated. */
export const RULES = [
  {
    id: "literal-color",
    summary: "Use --ou-color-* semantic tokens, not new raw color literals",
    regex: /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\s*\(/i,
  },
  {
    id: "tailwind-palette",
    summary: "Avoid one-off Tailwind palette shades in new UI",
    regex: /\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
  },
  {
    id: "pixel-font",
    summary: "Use the five typography roles instead of px font sizes",
    regex: /(?:font-size\s*:\s*|fontSize\s*:\s*['"]?|text-\[)\s*\d+(?:\.\d+)?px\b/i,
  },
  {
    id: "arbitrary-radius",
    summary: "Use the radius tokens rather than per-component radii",
    regex: /rounded-\[\d+(?:\.\d+)?(?:px|rem|em)\]|border-radius\s*:\s*\d+(?:\.\d+)?(?:px|rem|em)\b/i,
  },
  {
    id: "arbitrary-shadow",
    summary: "Use --ou-shadow-* instead of custom shadows",
    regex: /shadow-\[|box-shadow\s*:(?!\s*(?:var\(|none\b))/i,
  },
  {
    id: "arbitrary-layer",
    summary: "Use --ou-layer-* rather than numeric z-index",
    regex: /\bz-\[\d+\]|\bz-[1-9]\d*\b|z-index\s*:\s*[1-9]\d*\b/i,
  },
  {
    id: "raw-control",
    summary: "Compose components/ui (Select, Menu, Popover, Dialog) instead of raw <select> or hand-rolled overlays",
    regex: /<select\b|role=["']menu["']/,
  },
];

/* Only application sources are governed. Tokens are intentionally the single
 * allow-listed location for literal design values. Never whitelist components. */
export function isGovernedPath(file) {
  const normalized = file.replace(/\\/g, "/");
  if (!normalized.startsWith("frontend/src/")) return false;
  if (/\.generated\.[cm]?[jt]sx?$/.test(normalized)) return false;
  if (normalized === "frontend/src/styles/design-tokens.css") return false;
  return /\.(?:css|[cm]?[jt]sx?)$/.test(normalized);
}

export function violations(line, file) {
  if (!isGovernedPath(file)) return [];
  const trimmed = line.trim();
  // Comments and diff metadata are not executable style. Inline comments after
  // executable code are still inspected on the full line.
  if (/^(?:\/\/|\/\*|\*|<!--)/.test(trimmed)) return [];
  return RULES.filter((rule) => rule.regex.test(line)).map((rule) => rule.id);
}

export function parseAddedLines(diff) {
  const result = [];
  let file = "";
  let nextLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      file = "";
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result.push({ file, number: nextLine, line: line.slice(1) });
      nextLine++;
    } else if (line.startsWith(" ")) {
      nextLine++;
    }
  }
  return result.filter((entry) => entry.file && isGovernedPath(entry.file));
}

export function contrastRatio(hexA, hexB) {
  const luminance = (hex) => {
    const rgb = hex.replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(rgb)) throw new Error("Use six-digit hexadecimal colors");
    const channels = [0, 2, 4].map((offset) => parseInt(rgb.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const a = luminance(hexA), b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
