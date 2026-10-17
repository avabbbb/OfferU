export const bauhausFieldClassNames = {
  inputWrapper:
    "border border-[var(--border-strong)] bg-[var(--surface)] shadow-none group-data-[focus=true]:border-[var(--border-strong)]",
  input: "font-medium text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]",
  label: "text-xs font-medium text-[var(--foreground-muted)]",
  description: "text-[var(--foreground-muted)]",
  errorMessage: "font-medium text-[var(--primary-red)]",
};

export const bauhausSelectClassNames = {
  trigger:
    "border border-[var(--border-strong)] bg-[var(--surface)] shadow-none data-[hover=true]:border-[var(--border-strong)]",
  value: "font-medium text-[var(--foreground)]",
  label: "text-xs font-medium text-[var(--foreground-muted)]",
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
  tabList: "rounded-lg bg-[var(--surface-hover)] p-1 shadow-none",
  cursor: "rounded-md bg-[var(--surface)] shadow-sm",
  tab: "min-h-9 rounded-md px-3 data-[hover-unselected=true]:opacity-100",
  tabContent: "text-sm font-medium text-[var(--foreground-muted)] group-data-[selected=true]:text-[var(--foreground)]",
};