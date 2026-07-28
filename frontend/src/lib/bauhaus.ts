export const bauhausFieldClassNames = {
  inputWrapper:
    "border border-[var(--border-strong)] bg-[var(--surface)] shadow-none group-data-[focus=true]:border-[var(--border-strong)]",
  input: "font-medium text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]",
  label: "font-bold uppercase tracking-[0.14em] text-[11px] text-[var(--foreground-muted)]",
  description: "text-[var(--foreground-muted)]",
  errorMessage: "font-medium text-[var(--primary-red)]",
};

export const bauhausSelectClassNames = {
  trigger:
    "border border-[var(--border-strong)] bg-[var(--surface)] shadow-none data-[hover=true]:border-[var(--border-strong)]",
  value: "font-medium text-[var(--foreground)]",
  label: "font-bold uppercase tracking-[0.14em] text-[11px] text-[var(--foreground-muted)]",
  selectorIcon: "text-[var(--foreground-soft)]",
  popoverContent:
    "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] shadow-none",
  listboxWrapper: "max-h-64 bg-[var(--surface-muted)] p-1",
};

export const bauhausModalContentClassName =
  "border border-[var(--border-strong)] bg-[var(--surface-muted)] text-[var(--foreground)] shadow-none";

export const bauhausIconButtonClassName =
  "min-h-10 min-w-10 border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--foreground)] shadow-none transition-transform hover:-translate-y-[1px]";

export const bauhausTabsClassNames = {
  tabList: "rounded-md border border-[var(--border-strong)] bg-[var(--surface)] p-1 shadow-none",
  cursor: "rounded-sm bg-[var(--primary-red)]",
  tab: "min-h-10 rounded-sm px-4 data-[hover-unselected=true]:opacity-100",
  tabContent: "font-bold uppercase tracking-[0.12em] text-[11px] text-[var(--foreground)] group-data-[selected=true]:text-white",
};