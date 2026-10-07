import type { NormalizedResumeData, NormalizedResumeItem } from "./templateSettings";
import { HighlightText, RichSummary, cleanRichHtml, hasRichDescription, sortSections } from "./shared";

/**
 * 纸 · Editorial — a print-first template following the editorial rules popularised by
 * tw93/Kami (MIT): warm parchment page, one ink-blue accent kept under ~5% of the area,
 * serif-led hierarchy using only weights 400/500, warm greys instead of cool ones,
 * hairline rules instead of boxes, and dense body leading (≈1.42) for resumes.
 */
function EditorialItem({ item, keywords }: { item: NormalizedResumeItem; keywords: string[] }) {
  const heading = item.organization || item.title || item.subtitle;
  const role = item.organization ? item.title : "";
  const meta = [role, item.subtitle, item.location].filter((part) => part && part !== heading);
  const rich = hasRichDescription(item.descriptionHtml);
  return (
    <article className="ed-item">
      <div className="ed-item-head">
        <div className="ed-item-heading">
          {heading && <span className="ed-org"><HighlightText text={heading} keywords={keywords} /></span>}
          {meta.length > 0 && (
            <span className="ed-role">
              <HighlightText text={meta.join(" · ")} keywords={keywords} />
            </span>
          )}
        </div>
        {item.date && <span className="ed-date">{item.date}</span>}
      </div>
      {rich && item.descriptionHtml ? (
        <div className="ed-rich" dangerouslySetInnerHTML={{ __html: cleanRichHtml(item.descriptionHtml) }} />
      ) : item.bullets.length > 0 ? (
        <ul className="ed-list">
          {item.bullets.map((bullet, index) => (
            <li key={`${bullet}-${index}`}>
              <HighlightText text={bullet} keywords={keywords} />
            </li>
          ))}
        </ul>
      ) : null}
      {item.tags && item.tags.length > 0 && (
        <p className="ed-tags">
          {item.tags.map((tag, index) => (
            <span key={tag}>
              {index > 0 && <span className="ed-sep">·</span>}
              <HighlightText text={tag} keywords={keywords} />
            </span>
          ))}
        </p>
      )}
    </article>
  );
}

export function ResumeEditorial({ data, highlightKeywords }: { data: NormalizedResumeData; highlightKeywords: string[] }) {
  const sections = sortSections(data);
  const contact = data.contact;
  const contactParts = [contact.phone, contact.email, contact.website, contact.linkedin, contact.github, contact.wechat].filter(Boolean) as string[];
  return (
    <div className="ed-page">
      <header className="ed-header">
        <div>
          <h1 className="ed-name">{data.userName || "你的名字"}</h1>
          {data.title && (
            <p className="ed-tagline">
              <HighlightText text={data.title} keywords={highlightKeywords} />
            </p>
          )}
        </div>
        <div className="ed-contact">
          {contact.location && <div className="ed-loc">{contact.location}</div>}
          {contactParts.map((part, index) => (
            <div key={`${part}-${index}`}>{part}</div>
          ))}
        </div>
      </header>
      {data.summary && (
        <section className="ed-section">
          <h3 className="ed-section-title">概要</h3>
          <div className="ed-summary">
            <RichSummary data={data} keywords={highlightKeywords} />
          </div>
        </section>
      )}
      {sections.map((section) =>
        !section.visible || section.items.length === 0 ? null : (
          <section key={section.id} className="ed-section">
            <h3 className="ed-section-title">{section.title}</h3>
            {section.items.map((item) => (
              <EditorialItem key={item.id} item={item} keywords={highlightKeywords} />
            ))}
          </section>
        ),
      )}
    </div>
  );
}
