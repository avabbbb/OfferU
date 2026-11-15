// Share links pasted from phones: the iOS / Android share sheet wraps the link
// in text ("【标题】… http://xhslink.com/a/xxx 复制本条信息…") and appends a
// pile of tracking parameters. These helpers pull the link out and keep only
// what identifies the post. Recording only — nothing here fetches the page
// (public OfferU never crawls 小红书 / BOSS; the user opens them in their own browser).

const URL_RE = /https?:\/\/[^\s"'<>，。；！？、（）【】《》「」]+/i;

/** The first http(s) link inside a share text, without trailing punctuation; "" when there is none. */
export function shareLinkUrl(text: string): string {
  const match = URL_RE.exec(String(text || ""));
  return match ? match[0].replace(/[.,;!?)\]]+$/, "") : "";
}

/**
 * Normalize a 小红书 link: a note becomes https://www.xiaohongshu.com/explore/<note id>, keeping only
 * xsec_token (the note does not open without it); an xhslink.com short link drops its query. Other
 * links come back trimmed out of the share text. "" when the text holds no usable link.
 */
export function normalizeShareUrl(text: string): string {
  const url = shareLinkUrl(text);
  if (!url) return "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com")) {
    const note = /\/(?:explore|discovery\/item|item)\/([0-9a-zA-Z]+)/.exec(parsed.pathname)?.[1];
    if (note) {
      const token = /[?&]xsec_token=([^&#]*)/.exec(url)?.[1];
      return `https://www.xiaohongshu.com/explore/${note}${token ? `?xsec_token=${token}` : ""}`;
    }
  }
  if (host === "xhslink.com" || host.endsWith(".xhslink.com")) return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  return url;
}

/** job.source for a link: xhs / boss for those platforms (job-eval PLATFORMS), else the host. */
export function sourceOfUrl(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  if (/(^|\.)(xiaohongshu\.com|xhslink\.com)$/.test(host)) return "xhs";
  if (/(^|\.)zhipin\.com$/.test(host)) return "boss";
  return host;
}
