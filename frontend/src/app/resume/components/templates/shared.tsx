import DOMPurify from "dompurify";
import { splitBullets, textFromHtml } from "@/lib/resumeText";
import { KeywordHighlightView } from "../KeywordHighlightView";
import type { NormalizedResumeData, NormalizedResumeItem, NormalizedResumeSection } from "./templateSettings";

export { splitBullets, textFromHtml };

export function dateRange(start?: string, end?: string) {
  const parts = [start, end].map((item) => String(item || "").trim()).filter(Boolean);
  return parts.join(" - ");
}

/**
 * Decode HTML entities so that obfuscated dangerous protocols like
 * `ja&#x0A;vascript:` are detected before the browser strips control chars.
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#x0*([0-9a-fA-F]+);?/gi, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return code > 0 && code < 128 ? String.fromCharCode(code) : "";
    })
    .replace(/&#0*([0-9]+);?/gi, (_, dec: string) => {
      const code = parseInt(dec, 10);
      return code > 0 && code < 128 ? String.fromCharCode(code) : "";
    })
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

/**
 * SSR-safe fallback sanitizer (used when DOMPurify is unavailable).
 * Improved over the original: decodes entities before protocol checks,
 * filters data:/vbscript: URLs, and covers more dangerous tags.
 */
function sanitizeWithRegex(value: string): string {
  const dangerousTags =
    "script|iframe|object|embed|form|meta|base|svg|applet|link|style|input|button|textarea|video|audio|source";
  return value
    .replace(new RegExp(`<(${dangerousTags})[\\s>][\\s\\S]*?<\\/\\1>`, "gi"), "")
    .replace(new RegExp(`<(${dangerousTags})\\b[^>]*\\/?>`, "gi"), "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])([^"']*)\2/gi, (match, attr: string, quote: string, url: string) => {
      const decoded = decodeHtmlEntities(url).replace(/\s/g, "").toLowerCase();
      if (/^(javascript|vbscript|data):/.test(decoded)) {
        return `${attr}=${quote}#${quote}`;
      }
      return match;
    })
    .replace(/(href|src)\s*=\s*([^\s"'>]+)/gi, (match, attr: string, url: string) => {
      const decoded = decodeHtmlEntities(url).replace(/\s/g, "").toLowerCase();
      if (/^(javascript|vbscript|data):/.test(decoded)) {
        return `${attr}="#"`;
      }
      return match;
    })
    .replace(/\sstyle="([^"]*)"/gi, (_, content: string) => {
      const safe = content.match(/text-align:\s*(left|center|right|justify)/i);
      return safe ? ` style="${safe[0]}"` : "";
    })
    .replace(/\sstyle='([^']*)'/gi, (_, content: string) => {
      const safe = content.match(/text-align:\s*(left|center|right|justify)/i);
      return safe ? ` style="${safe[0]}"` : "";
    });
}

export function cleanRichHtml(value?: string) {
  if (!value) return "";
  if (typeof window !== "undefined") {
    return DOMPurify.sanitize(value, {
      ALLOWED_TAGS: ["p", "br", "strong", "b", "em", "i", "u", "s", "strike", "ul", "ol", "li", "a", "span", "div"],
      ALLOWED_ATTR: ["href", "style", "target", "rel"],
      ALLOW_DATA_ATTR: false,
    });
  }
  return sanitizeWithRegex(value);
}

const RICH_HTML_RE = /<\s*(strong|b|em|i|u|s|strike|ul|ol|li|a)\b/i;
const RICH_SUMMARY_RE = /<\s*(strong|b|em|i|u|s|strike|ul|ol|li|a|p)\b/i;

export function hasRichDescription(html?: string): boolean {
  return Boolean(html && RICH_HTML_RE.test(html));
}

export function hasRichSummary(html?: string): boolean {
  return Boolean(html && RICH_SUMMARY_RE.test(html));
}

export function HighlightText({ text, keywords }: { text: string; keywords: string[] }) {
  return <KeywordHighlightView text={text} keywords={keywords} />;
}

export function RichSummary({ data, keywords }: { data: NormalizedResumeData; keywords: string[] }) {
  if (hasRichSummary(data.summaryHtml)) {
    return <div className="resume-rich-summary" dangerouslySetInnerHTML={{ __html: cleanRichHtml(data.summaryHtml) }} />;
  }
  if (data.summary) {
    return (
      <p className="resume-summary-text">
        <HighlightText text={data.summary} keywords={keywords} />
      </p>
    );
  }
  return null;
}

export function ContactLine({ data }: { data: NormalizedResumeData }) {
  const contact = data.contact || {};
  const parts = [
    contact.phone,
    contact.email,
    contact.location,
    contact.linkedin,
    contact.github,
    contact.website,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div className="resume-meta">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>
          {index > 0 && <span aria-hidden> / </span>}
          {part}
        </span>
      ))}
    </div>
  );
}

export function SectionBlock({
  section,
  accent = false,
  small = false,
  keywords,
}: {
  section: NormalizedResumeSection;
  accent?: boolean;
  small?: boolean;
  keywords: string[];
}) {
  if (!section.visible || section.items.length === 0) return null;
  const titleClass = accent
    ? small
      ? "resume-section-title-accent-sm"
      : "resume-section-title-accent"
    : small
      ? "resume-section-title-sm"
      : "resume-section-title";
  return (
    <section className="resume-section">
      <h3 className={titleClass}>{section.title}</h3>
      <div className="resume-items">
        {section.items.map((item) => (
          <ResumeItem key={item.id} item={item} compact={small} keywords={keywords} />
        ))}
      </div>
    </section>
  );
}

export function ResumeItem({
  item,
  compact = false,
  keywords,
}: {
  item: NormalizedResumeItem;
  compact?: boolean;
  keywords: string[];
}) {
  const title = item.title || item.organization || item.subtitle;
  const subtitle = [item.organization && item.organization !== title ? item.organization : "", item.subtitle, item.location]
    .filter(Boolean)
    .join(" / ");
  const rich = hasRichDescription(item.descriptionHtml);
  return (
    <article className="resume-item">
      <div className="resume-row-tight">
        <div>
          {title && (
            <h4 className="resume-item-title">
              <HighlightText text={title} keywords={keywords} />
            </h4>
          )}
          {subtitle && (
            <div className="resume-item-subtitle">
              <HighlightText text={subtitle} keywords={keywords} />
            </div>
          )}
        </div>
        {item.date && <span className="resume-date">{item.date}</span>}
      </div>
      {item.url && <div className="resume-meta">{item.url}</div>}
      {rich && item.descriptionHtml ? (
        <div className="resume-rich-description" dangerouslySetInnerHTML={{ __html: cleanRichHtml(item.descriptionHtml) }} />
      ) : item.bullets.length > 0 ? (
        <ul className="resume-list">
          {item.bullets.map((bullet, index) => (
            <li key={`${bullet}-${index}`}>
              <span aria-hidden>•</span>
              <span>
                <HighlightText text={bullet} keywords={keywords} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {item.tags && item.tags.length > 0 && (
        <div className={compact ? "mt-1" : "mt-2"}>
          {item.tags.map((tag) => (
            <span key={tag} className="resume-skill-pill">
              <HighlightText text={tag} keywords={keywords} />
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function sortSections(data: NormalizedResumeData) {
  return [...data.sections].filter((section) => section.visible).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function splitTwoColumnSections(data: NormalizedResumeData) {
  const sections = sortSections(data);
  const sidebarKeys = new Set(["skill", "skills", "certificate", "certificates", "education"]);
  return {
    main: sections.filter((section) => !sidebarKeys.has(section.key)),
    sidebar: sections.filter((section) => sidebarKeys.has(section.key)),
  };
}
