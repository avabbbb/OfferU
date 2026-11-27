// 三个邮箱适配器对着精简的静态写信 / 读信页夹具跑（jsdom）。夹具只模仿结构，不是真实邮箱页面的快照：
// 真实页面改版时，先更新夹具再改选择器。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fallbackText, fillCompose, waitForCompose } from "./compose.js";
import type { ComposeRequest } from "./contract.js";
import { adapterFor, adapterForHost, WEBMAIL_MATCHES } from "./providers/index.js";

const fixture = (name: string) => readFileSync(join(__dirname, "__fixtures__", `${name}.html`), "utf8");

// jsdom 没有 DataTransfer：用一个类数组充当 FileList。
const fakeList = (files: File[]) => Object.assign([...files], { item: (index: number) => files[index] ?? null }) as unknown as FileList;

const request = (overrides: Partial<ComposeRequest> = {}): ComposeRequest => ({
  provider: "gmail",
  to: "hr@example.com",
  cc: [],
  subject: "应聘-前端开发实习-张三",
  body: "您好：\n\n我是张三，想应聘贵司「前端开发实习」岗位，简历见附件。\n\n张三",
  attachment: null,
  ...overrides,
});

const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], "张三-前端开发实习.pdf", { type: "application/pdf" });

function load(name: string): Document {
  document.body.innerHTML = fixture(name);
  return document;
}

/** 填写过程中任何「发送」都不该被点。 */
function guardSend(doc: Document) {
  const spy = vi.fn();
  doc.querySelectorAll('[data-testid="send"]').forEach((node) => node.addEventListener("click", spy));
  return spy;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Gmail adapter", () => {
  const gmail = adapterFor("gmail");

  it("opens the full-page compose with to / cc / subject / body in the URL", () => {
    const url = new URL(gmail.composeUrl(request({ cc: ["a@x.com", "b@x.com"] })));
    expect(url.origin + url.pathname).toBe("https://mail.google.com/mail/");
    expect(url.searchParams.get("view")).toBe("cm");
    expect(url.searchParams.get("to")).toBe("hr@example.com");
    expect(url.searchParams.get("cc")).toBe("a@x.com,b@x.com");
    expect(url.searchParams.get("su")).toBe("应聘-前端开发实习-张三");
    expect(url.searchParams.get("body")).toContain("简历见附件");
  });

  it("fills an empty compose form and attaches the PDF to the Filedata input, without clicking send", () => {
    const doc = load("gmail-compose");
    const send = guardSend(doc);
    const fields = gmail.findCompose(doc)!;
    expect(fields).not.toBeNull();
    const report = fillCompose(fields, request(), pdf(), fakeList);
    expect(report.ok).toBe(true);
    expect(report.steps.map((step) => step.field)).toEqual(["to", "subject", "body", "attachment"]);
    expect((doc.querySelector('input[aria-label="收件人"]') as HTMLInputElement).value).toBe("hr@example.com");
    expect((doc.querySelector('input[name="subjectbox"]') as HTMLInputElement).value).toBe("应聘-前端开发实习-张三");
    const body = doc.querySelector('[role="textbox"]')!;
    expect(body.querySelectorAll("div")).toHaveLength(5);
    expect(body.textContent).toContain("简历见附件");
    expect((doc.querySelector('input[name="Filedata"]') as HTMLInputElement).files?.[0]?.name).toBe("张三-前端开发实习.pdf");
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves URL-prefilled recipient, subject and body alone instead of duplicating them", () => {
    const doc = load("gmail-compose-prefilled");
    const fields = gmail.findCompose(doc)!;
    const before = fields.body!.innerHTML;
    const report = fillCompose(fields, request(), null, fakeList);
    expect(report.ok).toBe(true);
    expect((fields.to as HTMLInputElement).value).toBe("");
    expect(fields.body!.innerHTML).toBe(before);
  });

  it("reads the open message: sender, subject, date, text and only http(s) links", () => {
    const message = gmail.readOpen(load("gmail-read"))!;
    expect(message.from).toBe("字节跳动校园招聘 <campus@bytedance.com>");
    expect(message.subject).toBe("【字节跳动】前端开发实习 笔试邀请");
    expect(message.date).toBe("2026年11月26日 下午3:12");
    expect(message.text).toContain("2026-11-29 20:00");
    expect(message.links).toEqual(["https://exam.example.com/t/abc123"]);
  });

  it("is not on a read page while composing", () => {
    expect(gmail.readOpen(load("gmail-compose"))).toBeNull();
  });
});

describe("QQ mail adapter", () => {
  const qq = adapterFor("qq");

  it("finds fields by their row labels and fills them, cc included", () => {
    const doc = load("qq-compose");
    const send = guardSend(doc);
    const fields = qq.findCompose(doc)!;
    const report = fillCompose(fields, request({ provider: "qq", cc: ["lead@example.com"] }), pdf(), fakeList);
    expect(report.ok).toBe(true);
    expect((doc.querySelector(".compose_receiver input") as HTMLInputElement).value).toBe("hr@example.com");
    expect((doc.querySelector('input[aria-label="抄送人"]') as HTMLInputElement).value).toBe("lead@example.com");
    expect((doc.querySelector(".compose_subject input") as HTMLInputElement).value).toBe("应聘-前端开发实习-张三");
    expect(doc.querySelector(".xmail-editor-body")!.textContent).toContain("我是张三");
    expect((doc.querySelector(".compose_attach input") as HTMLInputElement).files?.[0]?.name).toBe("张三-前端开发实习.pdf");
    expect(send).not.toHaveBeenCalled();
  });

  it("clicks 写信 on the home page once, then fills the compose form that appears", async () => {
    const doc = load("qq-home");
    const write = doc.querySelector("a.nav-item")!;
    const click = vi.fn(() => { doc.getElementById("main")!.innerHTML = fixture("qq-compose"); });
    write.addEventListener("click", click);
    let clock = 0;
    const fields = await waitForCompose(doc, qq, { sleep: async (ms) => { clock += ms; }, now: () => clock, openAfterMs: 1000 });
    expect(click).toHaveBeenCalledTimes(1);
    expect(fields?.subject).toBeTruthy();
  });

  it("gives up (not logged in) after the timeout without throwing", async () => {
    document.body.innerHTML = "<form><input type=password name=p></form>";
    let clock = 0;
    const fields = await waitForCompose(document, qq, { sleep: async (ms) => { clock += ms; }, now: () => clock, timeoutMs: 3000 });
    expect(fields).toBeNull();
  });

  it("reads the open message", () => {
    const message = qq.readOpen(load("qq-read"))!;
    expect(message.from).toBe("腾讯招聘 <hr@tencent.com>");
    expect(message.subject).toBe("腾讯 2027 校招 | 面试邀请");
    expect(message.text).toContain("2026-12-01 14:00");
    expect(message.links).toEqual(["https://meeting.tencent.com/dm/xyz"]);
  });
});

describe("163 mail adapter", () => {
  const netease = adapterFor("163");

  it("writes the body into the same-origin editor iframe and fills suffix-id fields", () => {
    const doc = load("netease-compose");
    const frame = doc.querySelector("iframe")!;
    frame.contentDocument!.body.setAttribute("contenteditable", "true");
    const send = guardSend(doc);
    const fields = netease.findCompose(doc)!;
    expect(fields.body).toBe(frame.contentDocument!.body);
    const report = fillCompose(fields, request({ provider: "163" }), pdf(), fakeList);
    expect(report.ok).toBe(true);
    expect((doc.querySelector(".nui-editableAddr-ipt") as HTMLInputElement).value).toBe("hr@example.com");
    expect((doc.querySelector('input[id$="_subjectInput"]') as HTMLInputElement).value).toBe("应聘-前端开发实习-张三");
    expect(frame.contentDocument!.body.textContent).toContain("简历见附件");
    expect((doc.querySelector('input[name="attachments"]') as HTMLInputElement).files?.[0]?.name).toBe("张三-前端开发实习.pdf");
    expect(send).not.toHaveBeenCalled();
  });

  it("reads the open message", () => {
    const message = netease.readOpen(load("netease-read"))!;
    expect(message.from).toBe("美团校招 <campus@meituan.com>");
    expect(message.subject).toBe("美团 | 笔试通知");
    expect(message.links).toEqual(["https://exam.meituan.com/s/q1"]);
  });
});

describe("fallbacks", () => {
  it("reports each missing field and copies only what was not filled", () => {
    document.body.innerHTML = '<div><input aria-label="主题"><div contenteditable="true"></div></div>';
    const fields = adapterFor("qq").findCompose(document)!;
    const req = request({ provider: "qq" });
    const report = fillCompose(fields, req, pdf(), fakeList);
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.field === "to")).toMatchObject({ ok: false, note: "没找到收件人框" });
    // 没文件框：退回把文件拖进正文区，提示用户确认。
    expect(report.steps.find((step) => step.field === "attachment")?.note).toContain("请确认");
    expect(fallbackText(req, report)).toBe("收件人：hr@example.com");
  });
});

describe("registry", () => {
  it("maps hosts to adapters and matches the content-script entrypoint", () => {
    expect(adapterForHost("mail.google.com")?.id).toBe("gmail");
    expect(adapterForHost("wx.mail.qq.com")?.id).toBe("qq");
    expect(adapterForHost("mail.163.com")?.id).toBe("163");
    expect(adapterForHost("offeru.avabbbb.com")).toBeNull();
    const entry = readFileSync(join(__dirname, "../../entrypoints/mail.content.ts"), "utf8");
    for (const match of WEBMAIL_MATCHES) expect(entry).toContain(`"${match}"`);
  });
});
