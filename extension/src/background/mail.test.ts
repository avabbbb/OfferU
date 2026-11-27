import { describe, expect, it } from "vitest";

import { COMPOSE_TTL_MS, composeKey, handleMailMessage, INBOX_KEY, PROVIDER_KEY, type MailBackgroundDeps, type MailSender } from "./mail.js";

function memory() {
  const data = new Map<string, unknown>();
  return { data, get: async (key: string) => data.get(key), set: async (key: string, value: unknown) => { data.set(key, value); }, remove: async (key: string) => { data.delete(key); } };
}

function setup(options: { offeruTabs?: Array<{ id: number; url: string }>; delivered?: boolean } = {}) {
  const local = memory();
  const session = memory();
  const opened: string[] = [];
  const notified: number[] = [];
  let clock = 1_000;
  const deps: MailBackgroundDeps = {
    extensionId: "ext",
    version: "0.1.0",
    local,
    session,
    openTab: async (url) => { opened.push(url); return { id: 40 + opened.length }; },
    offeruTabs: async () => options.offeruTabs ?? [],
    notifyTab: async (tabId) => { notified.push(tabId); return options.delivered ?? true; },
    focusTab: async () => undefined,
    now: () => clock,
  };
  return { deps, local, session, opened, notified, advance: (ms: number) => { clock += ms; } };
}

const page: MailSender = { id: "ext", origin: "http://localhost:7410", url: "http://localhost:7410/jobs/1", frameId: 0, tab: { id: 7 } };
const gmailTab = (tabId: number): MailSender => ({ id: "ext", url: "https://mail.google.com/mail/?view=cm&fs=1", frameId: 0, tab: { id: tabId } });
const compose = { provider: "gmail", to: "hr@example.com", cc: [], subject: "应聘-前端-张三", body: "您好", attachment: { name: "简历.pdf", type: "application/pdf", base64: "JVBERg==" } };

describe("mail background", () => {
  it("answers the OfferU page handshake with the saved provider and remembers the page origin", async () => {
    const { deps, local } = setup();
    expect(await handleMailMessage({ type: "OFFERU_MAIL_HELLO" }, page, deps)).toMatchObject({ ok: true, mail: { protocol: 1, provider: null, compose: true } });
    await handleMailMessage({ type: "OFFERU_MAIL_SET_PROVIDER", provider: "qq" }, page, deps);
    expect(local.data.get(PROVIDER_KEY)).toBe("qq");
    expect(local.data.get("offeruWebOrigin")).toBe("http://localhost:7410");
    expect(await handleMailMessage({ type: "OFFERU_MAIL_SET_PROVIDER", provider: "outlook" }, page, deps)).toMatchObject({ ok: false });
  });

  it("refuses page messages from other sites and webmail messages from other pages", async () => {
    const { deps } = setup();
    expect(await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE", compose }, { ...page, origin: "https://evil.example", url: "https://evil.example/" }, deps)).toMatchObject({ ok: false });
    expect(await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE_TAKE" }, { ...page }, deps)).toMatchObject({ ok: false });
    expect(await handleMailMessage({ type: "OFFERU_MAIL_HELLO" }, { ...page, id: "other-extension" }, deps)).toMatchObject({ ok: false });
    expect(await handleMailMessage({ type: "SOMETHING_ELSE" }, page, deps)).toBeUndefined();
  });

  it("opens the webmail compose tab and hands the draft only to that tab, until done or expired", async () => {
    const { deps, opened, session, advance } = setup();
    expect(await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE", compose }, page, deps)).toEqual({ ok: true, provider: "gmail" });
    expect(opened[0]).toMatch(/^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
    expect(await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE_TAKE" }, gmailTab(99), deps)).toEqual({ ok: true, compose: null });
    const taken = await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE_TAKE" }, gmailTab(41), deps) as { compose: { attachment: { name: string } } };
    expect(taken.compose.attachment.name).toBe("简历.pdf");
    // 换成 163 的页面（同一个标签跳走了）不填。
    expect(await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE_TAKE" }, { ...gmailTab(41), url: "https://mail.163.com/js6/main.jsp" }, deps)).toEqual({ ok: true, compose: null });
    await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE_DONE" }, gmailTab(41), deps);
    expect(session.data.has(composeKey(41))).toBe(false);

    await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE", compose }, page, deps);
    advance(COMPOSE_TTL_MS + 1);
    expect(await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE_TAKE" }, gmailTab(42), deps)).toEqual({ ok: true, compose: null });
  });

  it("rejects an invalid compose request with a Chinese reason", async () => {
    const { deps, opened } = setup();
    expect(await handleMailMessage({ type: "OFFERU_MAIL_COMPOSE", compose: { ...compose, to: "not-an-email" } }, page, deps)).toEqual({ ok: false, error: "收件人邮箱不对" });
    expect(opened).toEqual([]);
  });

  it("queues a handed-off mail and pings the open OfferU tab; opens OfferU when none is open", async () => {
    const message = { from: "HR <hr@x.com>", subject: "面试邀请", date: "今天", text: "请参加面试", links: ["https://m.example.com/1", "javascript:alert(1)"] };
    const withTab = setup({ offeruTabs: [{ id: 3, url: "http://localhost:8766/api" }, { id: 5, url: "http://localhost:7410/" }] });
    await handleMailMessage({ type: "OFFERU_MAIL_HELLO" }, page, withTab.deps);
    expect(await handleMailMessage({ type: "OFFERU_MAIL_HANDOFF", message }, gmailTab(9), withTab.deps)).toEqual({ ok: true, delivered: "tab" });
    expect(withTab.notified).toEqual([5]);
    const inbox = await handleMailMessage({ type: "OFFERU_MAIL_INBOX_TAKE" }, page, withTab.deps) as { messages: Array<{ provider: string; links: string[]; url: string }> };
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ provider: "gmail", links: ["https://m.example.com/1"] });
    expect(withTab.session.data.has(INBOX_KEY)).toBe(false);

    const noTab = setup();
    expect(await handleMailMessage({ type: "OFFERU_MAIL_HANDOFF", message }, gmailTab(9), noTab.deps)).toEqual({ ok: true, delivered: "opened" });
    expect(noTab.opened).toEqual(["https://offeru.avabbbb.com/"]);
  });
});
