// Images and links that point at /api/* (uploaded photos, school emblems, Agent attachments).
//
// In the web build /api/* is answered inside the page by wrapping window.fetch
// (lib/local/backend.ts). <img src> and <a href> do not go through fetch, so a plain
// "/api/files/x" there would leave the browser and hit the Cloudflare Worker, which has no
// data. Here such a URL is read through fetch (answered in the page) and shown as a blob:
// URL instead. On the desktop / companion build the URL is used as is.
import { useEffect, useState, type ImgHTMLAttributes } from "react";

import { LOCAL_WEB } from "@/lib/local/mode";

/** True when the browser itself would have to load this URL from the in-page backend. */
export function isInPageApiUrl(url: string | null | undefined, localWeb = LOCAL_WEB): boolean {
  if (!localWeb || !url) return false;
  try {
    const base = globalThis.location?.href ?? "http://localhost/";
    const parsed = new URL(url, base);
    return parsed.origin === new URL(base).origin && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * A URL safe for <img src> / <a href>: unchanged outside the web build; in the web build an
 * /api/* URL becomes a blob: URL read through the in-page backend (undefined while loading
 * or when the file is missing).
 */
export function useApiAssetUrl(url: string | null | undefined): string | undefined {
  const inPage = isInPageApiUrl(url);
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!inPage || !url) return undefined;
    let alive = true;
    let created: string | undefined;
    setBlobUrl(undefined);
    fetch(url)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!alive || !blob) return;
        created = URL.createObjectURL(blob);
        setBlobUrl(created);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [inPage, url]);
  if (!url) return undefined;
  return inPage ? blobUrl : url;
}

/** <img> whose src may be an /api/* URL; see useApiAssetUrl. */
export function ApiImg({ src, ...props }: Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string | null | undefined }) {
  const resolved = useApiAssetUrl(src);
  // eslint-disable-next-line jsx-a11y/alt-text
  return resolved ? <img src={resolved} {...props} /> : <img {...props} />;
}
