// 网易 163 邮箱（mail.163.com）。写信需要登录后的 sid，所以先打开首页，再点「写 信」。
// 163 的 id 带随机前缀（如 _mail_input_3_xxx），只按后缀 / aria-label / 标签文字找；正文在同源编辑器 iframe 里。
import type { ComposeRequest } from "../contract.js";
import {
  composeRoot, findClickableByText, findEditable, findLabeledInput, linksIn, pickFileInput, queryFirst, reachableDocuments, readableText,
} from "../dom.js";
import type { WebmailAdapter } from "./types.js";

const SUBJECT = ['input[id$="_subjectInput"]', 'div[aria-label="邮件主题输入框"] input', 'input[aria-label*="主题"]'];
const TO = ['div[aria-label="收件人地址输入框"] input', "input.nui-editableAddr-ipt", 'input[aria-label*="收件人"]'];
const CC = ['div[aria-label="抄送人地址输入框"] input'];
const BODY = ["iframe.APP-editor-iframe"];
const FILE = ['input[type="file"][name="attachments"]', '[id$="_attachBrowser"] input[type="file"]'];

const READ_SUBJECT = ['h1[id$="_h1Subject"]', ".nui-fIBlock h1", "h1.subject"];
const READ_FROM = ['[id$="_from"] .nui-addr-email', ".nui-addr-email"];
const READ_FROM_NAME = ['[id$="_from"] .nui-addr-name', ".nui-addr-name"];
const READ_DATE = ['[id$="_lblDate"]', '[id$="_date"]'];
const READ_BODY = [".netease_mail_readhtml", 'div[id$="_dvContent"]', "#content"];

export const neteaseAdapter: WebmailAdapter = {
  id: "163",
  label: "网易 163 邮箱",
  hosts: ["mail.163.com"],
  composeUrl(_request: ComposeRequest) {
    return "https://mail.163.com/";
  },
  findCompose(doc) {
    const subject = queryFirst<HTMLInputElement>(doc, SUBJECT) ?? findLabeledInput(doc, ["主题"]);
    if (!subject) return null;
    const root = composeRoot(subject, ['[id$="_dvContainer"]', "form"]);
    const frame = queryFirst<HTMLIFrameElement>(root, BODY);
    let body: HTMLElement | null = null;
    try { body = frame?.contentDocument?.body ?? null; } catch { body = null; }
    return {
      root,
      subject,
      to: queryFirst<HTMLInputElement>(root, TO) ?? findLabeledInput(root, ["收件人"]),
      cc: queryFirst<HTMLInputElement>(root, CC),
      body: body ?? findEditable(root),
      file: pickFileInput([root, doc], FILE),
    };
  },
  openCompose(doc) {
    const button = queryFirst<HTMLElement>(doc, ['#dvNavTop li[title="写信"]', '[id$="_mail_component_"] .nui-mainBtn-icon']) ?? findClickableByText(doc, ["写信"]);
    if (!button) return false;
    button.click();
    return true;
  },
  readOpen(doc) {
    const docs = reachableDocuments(doc);
    const subject = queryFirst(docs, READ_SUBJECT);
    const body = queryFirst(docs, READ_BODY);
    if (!subject || !body) return null;
    const email = queryFirst(docs, READ_FROM)?.textContent?.replace(/[<>]/g, "").trim() ?? "";
    const name = queryFirst(docs, READ_FROM_NAME)?.textContent?.trim() ?? "";
    return {
      from: name && email ? `${name} <${email}>` : email || name,
      subject: subject.textContent?.trim() ?? "",
      date: queryFirst(docs, READ_DATE)?.textContent?.trim() ?? "",
      text: readableText(body),
      links: linksIn(body),
    };
  },
};
