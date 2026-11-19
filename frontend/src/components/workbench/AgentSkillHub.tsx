"use client";

// Skill Hub：浏览 Agent 的技能注册表（packages/core agent/skills.ts，GET /api/agent/skills）。
// 每个技能：做什么、什么时候自动加载（触发词）、完整方法；「试一下」把示例说法填进输入框。
// 底部是沙箱开关（可写 / 只读），和输入框「模式」菜单里的是同一个设置。

import { ChevronRight, Lock, PencilLine, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/ui";
import { agentSupportApi, type AgentSkillCatalog, type AgentSkillEntry } from "@/lib/api";
import type { SandboxMode } from "./AgentComposerControls";

/** 按标题、说明、触发词、正文筛技能。 */
export function filterSkills(skills: readonly AgentSkillEntry[], query: string): AgentSkillEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...skills];
  return skills.filter((skill) => [skill.id, skill.title, skill.when, skill.body, ...skill.keywords].some((text) => text.toLowerCase().includes(needle)));
}

export function AgentSkillHub({ open, onOpenChange, sandbox, onSandboxChange, onTry, load = agentSupportApi.skills }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sandbox: SandboxMode;
  onSandboxChange: (mode: SandboxMode) => void;
  /** 「试一下」：把示例说法填进输入框（不直接发）。 */
  onTry: (prompt: string) => void;
  load?: () => Promise<AgentSkillCatalog>;
}) {
  const [catalog, setCatalog] = useState<AgentSkillCatalog | null>(null);
  const [failed, setFailed] = useState("");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setFailed("");
    load().then((result) => { if (alive) setCatalog(result); }).catch((err: unknown) => {
      if (alive) setFailed(err instanceof Error ? err.message : "读不到技能列表");
    });
    return () => { alive = false; };
  }, [open, load]);

  const skills = useMemo(() => filterSkills(catalog?.skills ?? [], query), [catalog, query]);
  const readOnly = sandbox === "read_only";

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Skill Hub" className="ou-dialog-skill-hub"
      description="OfferU 做这几类事时会按对应技能的方法来。说到触发词时自动加载，也可以先在这里看看它会怎么做。">
      <div className="ou-skill-hub" data-testid="agent-skill-hub">
        <label className="ou-skill-hub__search">
          <Search size={14} aria-hidden />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜技能、触发词" aria-label="搜技能" />
        </label>
        {failed && <p className="ou-skill-hub__empty" role="alert">{failed}</p>}
        {!failed && !catalog && <p className="ou-skill-hub__empty">正在读取…</p>}
        {catalog && skills.length === 0 && <p className="ou-skill-hub__empty">没有匹配的技能</p>}
        <ul className="ou-skill-hub__list" aria-label="技能">
          {skills.map((skill) => {
            const isOpen = expanded === skill.id;
            return (
              <li key={skill.id} className="ou-skill-hub__item" data-testid="agent-skill-item" data-open={isOpen || undefined}>
                <button type="button" className="ou-skill-hub__head" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : skill.id)}>
                  <span className="ou-skill-hub__title">{skill.title}</span>
                  <span className="ou-skill-hub__when">{skill.when}</span>
                  <ChevronRight size={14} aria-hidden className="ou-skill-hub__chevron" />
                </button>
                {skill.keywords.length > 0 && (
                  <p className="ou-skill-hub__keywords" aria-label="自动加载的触发词">
                    {skill.keywords.map((keyword) => <span key={keyword} className="ou-skill-hub__keyword">{keyword}</span>)}
                  </p>
                )}
                {isOpen && <pre className="ou-skill-hub__body custom-scrollbar" data-testid="agent-skill-body">{skill.body.trim()}</pre>}
                {skill.example && (
                  <button type="button" className="ou-skill-hub__try" data-testid="agent-skill-try"
                    onClick={() => { onTry(skill.example); onOpenChange(false); }}>
                    试一下：{skill.example}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="ou-skill-hub__sandbox" role="radiogroup" aria-label="沙箱">
          <span className="ou-skill-hub__sandbox-label">沙箱</span>
          <button type="button" role="radio" aria-checked={!readOnly} className="ou-skill-hub__seg" data-testid="agent-sandbox-write"
            onClick={() => onSandboxChange("workspace_write")}>
            <PencilLine size={13} aria-hidden />可写
          </button>
          <button type="button" role="radio" aria-checked={readOnly} className="ou-skill-hub__seg" data-testid="agent-sandbox-readonly"
            onClick={() => onSandboxChange("read_only")}>
            <Lock size={13} aria-hidden />只读
          </button>
          <span className="ou-skill-hub__sandbox-hint">{readOnly ? "只查、只给建议；改档案、存岗位、写文档都会被拦下" : "可以改档案、岗位和文档，都能在「最近改动」里撤销"}</span>
        </div>
      </div>
    </Dialog>
  );
}
