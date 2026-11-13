import type { ReactNode } from "react";

// 侧栏面板（Agent 栏、详情抽屉）：一个标题行 + 直接铺在面板上的分节，不在灰底里再套白卡。
export function PanelHeader({ icon, title, subtitle, actions }: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="ou-panel-header">
      {icon ? <span className="ou-panel-icon" aria-hidden>{icon}</span> : null}
      <div className="ou-panel-heading">
        <h2 className="ou-panel-title">{title}</h2>
        {subtitle ? <p className="ou-panel-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="ou-panel-actions">{actions}</div> : null}
    </header>
  );
}

export function PanelSection({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="ou-panel-section">
      {title ? <h3 className="ou-panel-section-title">{title}</h3> : null}
      {children}
    </section>
  );
}
