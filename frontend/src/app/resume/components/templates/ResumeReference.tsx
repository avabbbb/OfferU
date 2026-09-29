import type { NormalizedResumeData, NormalizedResumeItem, ResumeTemplateType } from "./templateSettings";
import { cleanRichHtml, hasRichDescription, hasRichSummary, HighlightText, sortSections } from "./shared";

function contactValue(contact: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = contact[key];
    if (value) return value;
  }
  return "";
}

function ReferenceHeader({
  data,
  template,
}: {
  data: NormalizedResumeData;
  template: ResumeTemplateType;
}) {
  const contact = data.contact || {};
  const website = contactValue(contact, ["website", "personalWebsite", "homepage", "github", "linkedin"]);
  const age = contactValue(contact, ["age"]);
  const gender = contactValue(contact, ["gender", "sex"]);
  const nativePlace = contactValue(contact, ["nativePlace", "hometown", "籍贯"]);
  const status = contactValue(contact, ["status", "currentStatus", "当前状态"]);
  const logoUrl = contactValue(contact, ["schoolLogoUrl", "universityLogoUrl", "logoUrl", "school_logo_url"]);
  const showPhoto = !!data.photoUrl;
  const hasLogo = !!logoUrl;
  const headerClass = [
    "reference-header",
    !showPhoto && "reference-header-no-photo",
    !hasLogo && "reference-header-no-logo",
    !showPhoto && !hasLogo && "reference-header-text-only",
  ].filter(Boolean).join(" ");

  return (
    <header className={headerClass}>
      {showPhoto && (
        <div className="reference-photo-slot">
          <img src={data.photoUrl} alt="" className="reference-photo" />
        </div>
      )}
      <div className="reference-identity">
        <h1 className="reference-name">{data.userName || "姓名"}</h1>
        <div className="reference-contact-lines">
          <p>
            {contact.phone && <>电话：{contact.phone}</>}
            {contact.phone && contact.email && <span> | </span>}
            {contact.email && <>邮箱：{contact.email}</>}
          </p>
          {website && <p>个人网站：{website}</p>}
          {(age || gender || nativePlace) && (
            <p>
              {age && <>年龄：{age}</>}
              {age && (gender || nativePlace) && <span> | </span>}
              {gender && <>性别：{gender}</>}
              {gender && nativePlace && <span> | </span>}
              {nativePlace && <>籍贯：{nativePlace}</>}
            </p>
          )}
          {status && <p>当前状态：{status}</p>}
        </div>
      </div>
      {hasLogo && (
        <div className="reference-logo-slot">
          <img src={logoUrl} alt="" className="reference-logo" />
        </div>
      )}
    </header>
  );
}

function ReferenceRichText({ html }: { html?: string }) {
  const clean = cleanRichHtml(html);
  if (!clean) return null;
  return <div className="reference-rich" dangerouslySetInnerHTML={{ __html: clean }} />;
}

function ReferenceItem({ item, keywords }: { item: NormalizedResumeItem; keywords: string[] }) {
  const primaryTitle = item.organization || item.title;
  const secondaryTitle = item.organization && item.title !== item.organization ? item.title : item.subtitle;
  const extra = [secondaryTitle, item.location].filter(Boolean).join(" ");
  const rich = hasRichDescription(item.descriptionHtml);

  return (
    <article className="reference-item">
      {(primaryTitle || extra || item.date) && <div className="reference-item-row">
        <div className="reference-item-main">
          <strong>
            <HighlightText text={primaryTitle || ""} keywords={keywords} />
          </strong>
          {extra && (
            <span>
              - <HighlightText text={extra} keywords={keywords} />
            </span>
          )}
        </div>
        {item.date && <div className="reference-date">{item.date}</div>}
      </div>}
      {item.url && <div className="reference-line">{item.url}</div>}
      {item.descriptionHtml && rich ? (
        <ReferenceRichText html={item.descriptionHtml} />
      ) : item.bullets.length ? (
        <ul className="reference-bullets">
          {item.bullets.map((bullet, index) => (
            <li key={`${bullet}-${index}`}>
              <HighlightText text={bullet} keywords={keywords} />
            </li>
          ))}
        </ul>
      ) : null}
      {item.tags && item.tags.length > 0 && (
        <div className="reference-tags">
          {item.tags.map((tag) => (
            <span key={tag}>
              <HighlightText text={tag} keywords={keywords} />
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function ReferenceSection({
  title,
  items,
  keywords,
}: {
  title: string;
  items: NormalizedResumeItem[];
  keywords: string[];
}) {
  if (!items.length) return null;
  return (
    <section className="reference-section">
      <h2 className="reference-section-title">{title}</h2>
      <div className="reference-section-body">
        {items.map((item) => (
          <ReferenceItem key={item.id} item={item} keywords={keywords} />
        ))}
      </div>
    </section>
  );
}

export function ResumeReference({
  data,
  highlightKeywords,
  template,
}: {
  data: NormalizedResumeData;
  highlightKeywords: string[];
  template: ResumeTemplateType;
}) {
  const sections = sortSections(data);
  return (
    <div className={`reference-resume ${template}`}>
      <ReferenceHeader data={data} template={template} />
      {data.summary && (
        <section className="reference-section">
          <h2 className="reference-section-title">个人评价</h2>
          {hasRichSummary(data.summaryHtml) ? (
            <ReferenceRichText html={data.summaryHtml} />
          ) : (
            <p className="reference-summary">
              <HighlightText text={data.summary} keywords={highlightKeywords} />
            </p>
          )}
        </section>
      )}
      {sections.map((section) => (
        <ReferenceSection
          key={section.id}
          title={section.title}
          items={section.items}
          keywords={highlightKeywords}
        />
      ))}
    </div>
  );
}
