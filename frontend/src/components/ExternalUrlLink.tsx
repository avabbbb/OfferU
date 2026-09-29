"use client";

import { isTauri } from "@tauri-apps/api/core";
import type { AnchorHTMLAttributes, MouseEvent } from "react";

const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function normalizedExternalUrl(href: string): string {
  const parsed = new URL(href, typeof window === "undefined" ? "https://offeru.invalid/" : window.location.href);
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Unsupported external URL protocol");
  }
  return parsed.toString();
}

export async function openExternalUrl(href: string): Promise<void> {
  const url = normalizedExternalUrl(href);
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function ExternalUrlLink({
  href,
  onClick,
  target = "_blank",
  rel = "noopener noreferrer",
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !isTauri()) return;
    event.preventDefault();
    void openExternalUrl(href).catch(() => undefined);
  };

  return <a {...props} href={href} target={target} rel={rel} onClick={handleClick} />;
}
