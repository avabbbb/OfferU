// =============================================
// Puck 简历组件库 — 共享 config
// =============================================
// 用途：9 个简历段落 component 的 fields + render 定义，
//      供 /resume/[id]、/resume/print/[id] 共用。
// props 字段名严格对齐 frontend/src/lib/puckMigration.ts 的契约
// （即后端 content_json 真实字段名，不走本次 demo 简化版）
// =============================================

import { type Config } from "@puckeditor/core";

// ---- Props 类型 ----

export type HeaderProps = {
  name: string;
  title: string;
  email: string;
  phone: string;
  location: string;
  photoUrl: string;
};

export type SummaryProps = {
  text: string;
};

export type ExperienceEntryProps = {
  company: string;
  position: string;
  location: string;
  startDate: string;
  endDate: string;
  description: string;
};

export type EducationItemProps = {
  school: string;
  degree: string;
  major: string;
  startDate: string;
  endDate: string;
  gpa: string;
  description: string;
};

export type ProjectItemProps = {
  name: string;
  role: string;
  url: string;
  startDate: string;
  endDate: string;
  description: string;
};

export type SkillGroupProps = {
  category: string;
  items: string;
};

export type CertificateItemProps = {
  name: string;
  scoreOrLevel: string;
  issuer: string;
  date: string;
  url: string;
  description: string;
};

export type AwardItemProps = {
  awardName: string;
  issuer: string;
  awardedAt: string;
  description: string;
};

export type CustomItemProps = {
  experienceTitle: string;
  startDate: string;
  endDate: string;
  description: string;
};

// ---- 共用样式片段 ----

const sectionTitleStyle = {
  fontSize: 13,
  fontWeight: 600,
  letterSpacing: 1,
  color: "var(--resume-primary, #37352f)",
  margin: "0 0 6px",
  textTransform: "uppercase" as const,
};

const articleMargin = { marginBottom: 14 };

function drawBullets(description: string) {
  const bullets = (description || "").split("\n").filter(Boolean);
  if (bullets.length === 0) return null;
  return (
    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: "var(--resume-primary, #37352f)" }}>
      {bullets.map((b, i) => (
        <li key={i}>{b}</li>
      ))}
    </ul>
  );
}

// ---- config ----

export const puckConfig: Config = {
  components: {
    Header: {
      fields: [
        { name: "name", type: "text", label: "姓名" },
        { name: "title", type: "text", label: "职位" },
        { name: "email", type: "text", label: "邮箱" },
        { name: "phone", type: "text", label: "电话" },
        { name: "location", type: "text", label: "所在地" },
        { name: "photoUrl", type: "text", label: "头像 URL（可选）" },
      ],
      render: ({ name, title, email, phone, location, photoUrl }: HeaderProps) => (
        <header
          style={{
            textAlign: "center",
            borderBottom: "1px solid var(--resume-border, #e5e5e5)",
            paddingBottom: 12,
            marginBottom: 16,
          }}
        >
          {photoUrl && (
            <img
              src={photoUrl}
              alt=""
              style={{
                width: 64,
                height: 64,
                borderRadius: "50%",
                objectFit: "cover",
                marginBottom: 6,
              }}
            />
          )}
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: "0 0 4px" }}>
            {name || "你的姓名"}
          </h1>
          {title && (
            <p style={{ fontSize: 14, color: "var(--resume-secondary, #666)", margin: "0 0 6px" }}>{title}</p>
          )}
          <div style={{ fontSize: 12, color: "var(--resume-tertiary, #999)" }}>
            {[email, phone, location].filter(Boolean).join(" · ")}
          </div>
        </header>
      ),
    },
    Summary: {
      fields: [{ name: "text", type: "textarea", label: "简介" } as any],
      render: ({ text }: SummaryProps) => (
        <section style={{ marginBottom: 16 }}>
          <h3 style={sectionTitleStyle}>个人简介</h3>
          <p
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--resume-primary, #37352f)",
              margin: 0,
              textAlign: "justify",
            }}
          >
            {text || "（在此处撰写个人简介）"}
          </p>
        </section>
      ),
    },
    ExperienceEntry: {
      fields: [
        { name: "company", type: "text", label: "公司" },
        { name: "position", type: "text", label: "职位" },
        { name: "location", type: "text", label: "地点（可选）" },
        { name: "startDate", type: "text", label: "开始日期" },
        { name: "endDate", type: "text", label: "结束日期" },
        { name: "description", type: "textarea", label: "描述（每行一条要点）" } as any,
      ],
      render: ({ company, position, location, startDate, endDate, description }: ExperienceEntryProps) => {
        const dateStr = [startDate, endDate].filter(Boolean).join(" — ");
        return (
          <article style={articleMargin}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 2,
              }}
            >
              <strong style={{ fontSize: 13, color: "var(--resume-primary, #37352f)" }}>
                {position || "职位"}{" "}
                {company && <span style={{ color: "var(--resume-secondary, #666)", fontWeight: 400 }}>· {company}</span>}
              </strong>
              {dateStr && <span style={{ fontSize: 12, color: "var(--resume-tertiary, #999)" }}>{dateStr}</span>}
            </div>
            {location && (
              <div style={{ fontSize: 12, color: "var(--resume-tertiary, #999)", marginBottom: 4 }}>{location}</div>
            )}
            {drawBullets(description ?? "")}
          </article>
        );
      },
    },
    EducationItem: {
      fields: [
        { name: "school", type: "text", label: "学校" },
        { name: "degree", type: "text", label: "学位" },
        { name: "major", type: "text", label: "专业" },
        { name: "startDate", type: "text", label: "开始日期" },
        { name: "endDate", type: "text", label: "结束日期" },
        { name: "gpa", type: "text", label: "GPA / 排名（可选）" },
        { name: "description", type: "textarea", label: "备注（可选）" } as any,
      ],
      render: ({ school, degree, major, startDate, endDate, gpa, description }: EducationItemProps) => {
        const dateStr = [startDate, endDate].filter(Boolean).join(" — ");
        return (
          <article style={articleMargin}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 2,
              }}
            >
              <strong style={{ fontSize: 13, color: "var(--resume-primary, #37352f)" }}>
                {school || "学校"}{" "}
                {major && <span style={{ color: "var(--resume-secondary, #666)", fontWeight: 400 }}>· {major}</span>}
              </strong>
              {dateStr && <span style={{ fontSize: 12, color: "var(--resume-tertiary, #999)" }}>{dateStr}</span>}
            </div>
            <div style={{ fontSize: 12, color: "var(--resume-tertiary, #999)", marginBottom: 4 }}>
              {[degree, gpa ? `GPA ${gpa}` : ""].filter(Boolean).join(" · ")}
            </div>
            {drawBullets(description ?? "")}
          </article>
        );
      },
    },
    ProjectItem: {
      fields: [
        { name: "name", type: "text", label: "项目名" },
        { name: "role", type: "text", label: "角色" },
        { name: "url", type: "text", label: "链接（可选）" },
        { name: "startDate", type: "text", label: "开始日期" },
        { name: "endDate", type: "text", label: "结束日期" },
        { name: "description", type: "textarea", label: "描述（每行一条要点）" } as any,
      ],
      render: ({ name, role, url, startDate, endDate, description }: ProjectItemProps) => {
        const dateStr = [startDate, endDate].filter(Boolean).join(" — ");
        return (
          <article style={articleMargin}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 2,
              }}
            >
              <strong style={{ fontSize: 13, color: "var(--resume-primary, #37352f)" }}>
                {name || "项目名"}{" "}
                {role && <span style={{ color: "var(--resume-secondary, #666)", fontWeight: 400 }}>· {role}</span>}
              </strong>
              {dateStr && <span style={{ fontSize: 12, color: "var(--resume-tertiary, #999)" }}>{dateStr}</span>}
            </div>
            {url && (
              <div style={{ fontSize: 12, color: "var(--resume-link, #5b9cd6)", marginBottom: 4 }}>{url}</div>
            )}
            {drawBullets(description ?? "")}
          </article>
        );
      },
    },
    SkillGroup: {
      fields: [
        { name: "category", type: "text", label: "分类名" },
        {
          name: "items",
          type: "textarea",
          label: "技能（每行一条，或逗号分隔）",
        } as any,
      ],
      render: ({ category, items }: SkillGroupProps) => {
        const list = (items || "")
          .split(/[\n,，、]/)
          .map((s: string) => s.trim())
          .filter(Boolean);
        return (
          <section style={{ marginBottom: 14 }}>
            {category && <h3 style={sectionTitleStyle}>{category}</h3>}
            {list.length > 0 && (
              <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--resume-primary, #37352f)" }}>
                {list.map((s: string, i: number) => (
                  <span
                    key={i}
                    style={{
                      display: "inline-block",
                      padding: "2px 8px",
                      margin: "0 6px 6px 0",
                      border: "1px solid var(--resume-border, #e5e5e5)",
                      borderRadius: 3,
                      fontSize: 12,
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}
          </section>
        );
      },
    },
    CertificateItem: {
      fields: [
        { name: "name", type: "text", label: "证书名" },
        { name: "scoreOrLevel", type: "text", label: "成绩 / 等级（可选）" },
        { name: "issuer", type: "text", label: "颁发机构" },
        { name: "date", type: "text", label: "日期" },
        { name: "url", type: "text", label: "链接（可选）" },
        { name: "description", type: "textarea", label: "备注（可选）" } as any,
      ],
      render: ({ name, scoreOrLevel, issuer, date, url, description }: CertificateItemProps) => (
        <article style={articleMargin}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 2,
            }}
          >
            <strong style={{ fontSize: 13, color: "var(--resume-primary, #37352f)" }}>
              {name || "证书名"}{" "}
              {scoreOrLevel && (
                <span style={{ color: "var(--resume-secondary, #666)", fontWeight: 400 }}>· {scoreOrLevel}</span>
              )}
            </strong>
            {date && <span style={{ fontSize: 12, color: "var(--resume-tertiary, #999)" }}>{date}</span>}
          </div>
          {(issuer || url) && (
            <div style={{ fontSize: 12, color: "var(--resume-tertiary, #999)", marginBottom: 4 }}>
              {issuer}
              {url && <span style={{ color: "var(--resume-link, #5b9cd6)", marginLeft: 6 }}>{url}</span>}
            </div>
          )}
          {drawBullets(description ?? "")}
        </article>
      ),
    },
    AwardItem: {
      fields: [
        { name: "awardName", type: "text", label: "奖项名" },
        { name: "issuer", type: "text", label: "颁发机构（可选）" },
        { name: "awardedAt", type: "text", label: "日期" },
        { name: "description", type: "textarea", label: "描述（可选，每行一条要点）" } as any,
      ],
      render: ({ awardName, issuer, awardedAt, description }: AwardItemProps) => (
        <article style={articleMargin}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 2,
            }}
          >
            <strong style={{ fontSize: 13, color: "var(--resume-primary, #37352f)" }}>
              {awardName || "奖项名"}{" "}
              {issuer && <span style={{ color: "var(--resume-secondary, #666)", fontWeight: 400 }}>· {issuer}</span>}
            </strong>
            {awardedAt && <span style={{ fontSize: 12, color: "var(--resume-tertiary, #999)" }}>{awardedAt}</span>}
          </div>
          {drawBullets(description ?? "")}
        </article>
      ),
    },
    CustomItem: {
      fields: [
        { name: "experienceTitle", type: "text", label: "段落标题" },
        { name: "startDate", type: "text", label: "开始日期（可选）" },
        { name: "endDate", type: "text", label: "结束日期（可选）" },
        {
          name: "description",
          type: "textarea",
          label: "正文（每段空行分隔，每行一条要点）",
        } as any,
      ],
      render: ({ experienceTitle, startDate, endDate, description }: CustomItemProps) => {
        const dateStr = [startDate, endDate].filter(Boolean).join(" — ");
        const paragraphs = (description || "").split(/\n\s*\n/).filter(Boolean);
        return (
          <section style={{ marginBottom: 16 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: 6,
              }}
            >
              {experienceTitle && (
                <h3 style={{ ...sectionTitleStyle, margin: 0 }}>{experienceTitle}</h3>
              )}
              {dateStr && <span style={{ fontSize: 12, color: "var(--resume-tertiary, #999)" }}>{dateStr}</span>}
            </div>
            {paragraphs.length > 0 ? (
              paragraphs.map((p, i) => (
                <p
                  key={i}
                  style={{
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: "var(--resume-primary, #37352f)",
                    margin: "0 0 6px",
                    textAlign: "justify",
                  }}
                >
                  {p}
                </p>
              ))
            ) : (
              <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--resume-tertiary, #999)", margin: 0 }}>
                {description || "（在此处填写正文）"}
              </p>
            )}
          </section>
        );
      },
    },
  },
};

export default puckConfig;